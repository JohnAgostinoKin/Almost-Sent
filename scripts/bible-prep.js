#!/usr/bin/env node
// scripts/bible-prep.js
//
// Runs the first 100 inputs from bake/inputs.txt (the same locked 200-
// input corpus scripts/bake-blind.js draws from) through the current
// production engine — real primary + wildcard generation, safety, and
// the taste judge's gates and scoring, the same shape api/draft.js's own
// runGenerationRound uses — MINUS the pairwise final call, which only
// ever decides ranking between two already-good candidates and has
// nothing to contribute to a wide rating pool. Every candidate that
// actually cleared taste's gates (a real, displayed-quality line — not
// raw model output, not something safety would have flagged) gets
// written to bible/lines.json, paired with the original text it replied
// to.
//
// scripts/bible-rate.html reads that file to show John real lines, in
// context, to rate for lib/judge.js's calibration bank (bible.csv).
//
//   LLM_API_KEY=...      npm run bible-prep
//   BIBLE_PREP_LIMIT=20  npm run bible-prep   # fewer inputs, for a cheaper test run
//
// Cost/time note: 100 inputs, each costing four parallel primary calls
// plus a wildcard call plus up to ten safety calls plus a taste judge
// call, is a real bill and a real wait — use BIBLE_PREP_LIMIT for a
// smaller pass first. Results are written incrementally (flushed after
// every input), so an interrupted run doesn't lose what it already paid
// for — re-running overwrites bible/lines.json from scratch, it doesn't
// resume.

const fs = require("fs");
const path = require("path");

const { callLLM } = require("../lib/llm");
const { extractArray, extractPremiseCandidates, normalizeItem, isRefusal, filterLines } = require("../lib/postprocess");
const { judgeOneLine, judgeCandidates } = require("../lib/judge");
const { composeDraft } = require("../lib/compose");
const { GENERATOR_MODEL, WILDCARD_MODEL, PRIMARY_LANE_GROUPS } = require("../lib/prompt");

// --- tiny .env loader (no dotenv dependency) — same as scripts/bake.js ---
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    val = val.replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) {
  console.error("LLM_API_KEY is not set. Put it in .env or export it, then re-run.");
  process.exit(1);
}

const INPUTS_PATH = path.join(__dirname, "..", "bake", "inputs.txt");
const OUT_DIR = path.join(__dirname, "..", "bible");
const OUT_PATH = path.join(OUT_DIR, "lines.json");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const ALL_INPUTS = fs.readFileSync(INPUTS_PATH, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const LIMIT = process.env.BIBLE_PREP_LIMIT ? parseInt(process.env.BIBLE_PREP_LIMIT, 10) : 100;
const INPUTS = ALL_INPUTS.slice(0, LIMIT);

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// One primary lane-group call — same builder, same parsing
// (extractPremiseCandidates, premise-first generation's own output
// shape) api/draft.js's callOneGenerator uses for a primary call. No
// retry/fallback-model chain the way api/draft.js's runGenerator has —
// a group that fails here just contributes zero candidates for this
// input rather than costing a second call; this script is prepping a
// wide pool from 100 inputs, not trying to guarantee every single one
// produces something.
async function callOnePrimaryGroup(lanes, input) {
  try {
    const result = await callLLM(apiKey, GENERATOR_MODEL, input, { lanes: lanes });
    const parsedObj = extractPremiseCandidates(result.text);
    const parsed = parsedObj && parsedObj.candidates;
    if (!parsed) return [];
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return [];
    return filterLines(items, input).kept;
  } catch (err) {
    return [];
  }
}

// The wildcard (raunchy/gross) call — bare array output, unchanged from
// premise-first generation (that's a primary-only mechanic).
async function callWildcardGroup(input) {
  try {
    const result = await callLLM(apiKey, WILDCARD_MODEL, input, { kind: "wildcard" });
    const parsed = extractArray(result.text);
    if (!parsed) return [];
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return [];
    return filterLines(items, input).kept;
  } catch (err) {
    return [];
  }
}

// Full generate-then-judge pass for one input, no pairwise. Returns the
// {original, text, lane, q, shock} rows this input contributes to
// bible/lines.json — every candidate that cleared taste's five gates
// AND wasn't safety-flagged. An input whose taste call fails outright
// contributes nothing rather than guessing at "displayed quality"
// without real scores to judge it by.
async function processInput(input) {
  const [primaryGroups, wildcardLines] = await Promise.all([
    Promise.all(PRIMARY_LANE_GROUPS.map(function (lanes) { return callOnePrimaryGroup(lanes, input); })),
    callWildcardGroup(input)
  ]);
  const allCandidates = primaryGroups.reduce(function (acc, lines) { return acc.concat(lines); }, []).concat(wildcardLines);
  if (!allCandidates.length) return [];

  const [safetyVerdicts, taste] = await Promise.all([
    Promise.all(allCandidates.map(function (item) { return judgeOneLine(apiKey, composeDraft(input, item.text)); })),
    judgeCandidates(apiKey, input, allCandidates)
  ]);
  if (!taste.ok) return [];

  const flagged = new Set();
  allCandidates.forEach(function (item, i) { if (safetyVerdicts[i].verdict === true) flagged.add(item); });

  return taste.details
    .filter(function (d) { return !d.eliminated && !flagged.has(d.candidate); })
    .map(function (d) {
      return { original: input, text: d.candidate.text, lane: d.lane, q: d.q, shock: d.shock };
    });
}

async function main() {
  console.log("bible-prep: " + INPUTS.length + " input(s), no pairwise, writing to " + OUT_PATH + "\n");
  const allLines = [];
  for (let i = 0; i < INPUTS.length; i++) {
    const input = INPUTS[i];
    process.stdout.write("[" + (i + 1) + "/" + INPUTS.length + "] " + input);
    const rows = await processInput(input);
    allLines.push.apply(allLines, rows);
    process.stdout.write(" -> " + rows.length + " line(s)\n");
    // Flushed after every input, not just at the end — same "don't lose
    // what's already paid for" reasoning as scripts/bake-blind.js's own
    // incremental writes. Re-running overwrites from scratch, it doesn't
    // resume a partial run.
    fs.writeFileSync(OUT_PATH, JSON.stringify(allLines, null, 2));
    await sleep(500);
  }
  console.log("\ndone. wrote " + allLines.length + " displayed-quality line(s) across " + INPUTS.length + " input(s) to " + OUT_PATH);
  console.log("Next: open scripts/bible-rate.html and load bible/lines.json.");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});

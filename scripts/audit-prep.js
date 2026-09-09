#!/usr/bin/env node
// scripts/audit-prep.js
//
// The v4 addendum's own section H: "the critical diagnostic." Every other
// tool in this repo (scripts/bible-prep.js included) only ever shows John
// the candidates that already survived judging — which means a real bug
// in the JUDGE (picking the wrong survivor) or in the GENERATOR (never
// writing anything good in the first place) look identical from the
// outside: three lines, none of them funny. This script keeps the whole
// pool instead — every candidate that cleared the basic postprocess
// filter, whichever lane or model wrote it, whether taste eliminated it
// or scored it, whether safety flagged it, and which one the REAL
// selection algorithm (taste rank + the pairwise final call) actually
// picked for position 1 — for a small, deliberately narrow set of inputs
// (25 by default) meant to be read by a person, one at a time, not
// tallied in bulk the way bible-prep.js's wider pool is.
//
// scripts/bible-rate.html's "candidate audit" mode reads bible/audit-
// pool.json and shows all of it per input, letting John pick his own
// favorite (or "none are funny") — see that file's own comment for what
// the three possible readings of a disagreement mean.
//
//   LLM_API_KEY=...     npm run audit-prep
//   AUDIT_PREP_LIMIT=5  npm run audit-prep   # fewer inputs, for a cheap test run
//
// Cost/time note: 25 inputs, each costing one Hermes call (seven
// candidates), one GPT-5.4 call (two), up to nine safety calls, a taste
// judge call, and (when there are at least two survivors) one pairwise
// call, is a real bill — small on purpose, this tool is meant to be read
// closely, not sampled statistically the way bible-prep's 100 is.

const fs = require("fs");
const path = require("path");

const { callLLM } = require("../lib/llm");
const { extractPremiseCandidates, normalizeItem, isRefusal, filterLines } = require("../lib/postprocess");
const { judgeOneLine, judgeCandidates, judgePairwise } = require("../lib/judge");
const { composeDraft } = require("../lib/compose");
const { GENERATOR_MODEL, WILDCARD_MODEL, WILDCARD_LANE_PLAN, primaryLanePlan } = require("../lib/prompt");

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
const OUT_PATH = path.join(OUT_DIR, "audit-pool.json");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const ALL_INPUTS = fs.readFileSync(INPUTS_PATH, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const LIMIT = process.env.AUDIT_PREP_LIMIT ? parseInt(process.env.AUDIT_PREP_LIMIT, 10) : 25;
const INPUTS = ALL_INPUTS.slice(0, LIMIT);

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// One generator call, tagged with which model wrote it — no retry/
// fallback chain (same reasoning as bible-prep.js: this is a narrow,
// closely-read sample, not a pipeline trying to guarantee output for
// every input at any cost).
async function callOneGenerator(model, lanes, kind, input) {
  try {
    const result = await callLLM(apiKey, model, input, { lanes: lanes, kind: kind });
    const parsedObj = extractPremiseCandidates(result.text);
    const parsed = parsedObj && parsedObj.candidates;
    if (!parsed) return [];
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return [];
    return filterLines(items, input).kept.map(function (item) { return { lane: item.lane, anchor: item.anchor, text: item.text, model: model }; });
  } catch (err) {
    return [];
  }
}

// The full pipeline for one input, keeping every candidate — not just
// survivors. Returns { original, candidates: [...] }, one entry per
// candidate that cleared the postprocess filter:
//   { lane, model, text, eliminated, killedBy, q, reaction, safetyFlagged,
//     position }
// `position` is 1/2/3 for whichever candidates the REAL selection
// algorithm (taste rank, safety removal, the pairwise final swap) would
// actually have shown, null for everything else in the pool. This
// mirrors api/draft.js's own position-1/2/3 rule (intensity-gated, not
// just top-3-by-q) closely enough to answer "which one did the judge
// pick" honestly — it does not run the diversity dedup api/draft.js's
// handler applies across positions, since that's a display-time nicety,
// not part of what this tool is auditing.
async function processInput(input) {
  const [wildcardLines, primaryLines] = await Promise.all([
    callOneGenerator(WILDCARD_MODEL, WILDCARD_LANE_PLAN, "wildcard", input),
    callOneGenerator(GENERATOR_MODEL, primaryLanePlan({}), "primary", input)
  ]);
  const allCandidates = wildcardLines.concat(primaryLines);
  if (!allCandidates.length) return { original: input, candidates: [] };

  const [safetyVerdicts, taste] = await Promise.all([
    Promise.all(allCandidates.map(function (item) { return judgeOneLine(apiKey, composeDraft(input, item.text)); })),
    judgeCandidates(apiKey, input, allCandidates)
  ]);

  const flagged = new Set();
  allCandidates.forEach(function (item, i) { if (safetyVerdicts[i].verdict === true) flagged.add(item); });

  let survivors = [];
  const byIdentity = new Map(); // candidate object identity -> {q, reaction, eliminated, killedBy}
  if (taste.ok) {
    taste.details.forEach(function (d) { byIdentity.set(d.candidate, d); });
    survivors = taste.ranked.filter(function (r) { return !flagged.has(r.candidate); });
  }

  // Same intensity-gated position rule api/draft.js's handler uses, minus
  // the diversity tracker (see this function's own header comment).
  const positions = [];
  if (survivors.length) positions.push(survivors[0]);
  for (let need = 2; need <= 3 && positions.length === need - 1; need++) {
    const prev = positions[need - 2];
    const remaining = survivors.slice(1).filter(function (s) { return positions.indexOf(s) === -1; });
    const next = prev.reaction == null ? remaining[0] : remaining.filter(function (s) { return s.reaction > prev.reaction && s.q >= 0.7 * prev.q; })[0];
    if (!next) break;
    positions.push(next);
  }

  // Pairwise final — same rule as production: only meaningful with a real
  // top two by q, and only swaps which SURVIVOR ends up in `positions[0]`.
  if (taste.ok && positions.length >= 2 && positions[0] === survivors[0] && positions[1] === survivors[1]) {
    const pw = await judgePairwise(apiKey, input, survivors[0].candidate, survivors[1].candidate);
    if (pw.winner === 2) {
      const tmp = positions[0]; positions[0] = positions[1]; positions[1] = tmp;
    }
  }

  const positionOf = new Map();
  positions.forEach(function (p, i) { positionOf.set(p.candidate, i + 1); });

  const candidates = allCandidates.map(function (item) {
    const detail = byIdentity.get(item);
    return {
      lane: item.lane,
      model: item.model,
      text: item.text,
      eliminated: detail ? detail.eliminated : null,
      killedBy: detail ? detail.killedBy : (taste.ok ? "no-verdict" : "taste-call-failed"),
      q: detail && !detail.eliminated ? detail.q : null,
      reaction: detail && !detail.eliminated ? detail.reaction : null,
      safetyFlagged: flagged.has(item),
      position: positionOf.get(item) || null
    };
  });

  return { original: input, candidates: candidates };
}

async function main() {
  console.log("audit-prep: " + INPUTS.length + " input(s), full raw pool + real selection, writing to " + OUT_PATH + "\n");
  const rows = [];
  for (let i = 0; i < INPUTS.length; i++) {
    const input = INPUTS[i];
    process.stdout.write("[" + (i + 1) + "/" + INPUTS.length + "] " + input);
    const row = await processInput(input);
    rows.push(row);
    process.stdout.write(" -> " + row.candidates.length + " candidate(s)\n");
    // Flushed after every input — same "don't lose what's already paid
    // for" reasoning as every other bake/bible script here.
    fs.writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2));
    await sleep(500);
  }
  console.log("\ndone. wrote " + rows.length + " input(s) to " + OUT_PATH);
  console.log("Next: open scripts/bible-rate.html, switch to candidate audit mode, and load bible/audit-pool.json.");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});

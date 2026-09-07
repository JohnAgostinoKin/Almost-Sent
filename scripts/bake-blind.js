#!/usr/bin/env node
// scripts/bake-blind.js
//
// Reading raw output streams to judge quality stopped working once there
// were four systems in play and everyone involved was too close to all of
// them. This is the harness the reviewer asked for instead: run the same
// locked 200-input set (bake/inputs.txt) through every system below, save
// each system's top three per input, and let scripts/bake-rate.html show
// them to real people blind — no labels, random order — before anyone
// decides anything. scripts/bake-tally.js is what unblinds the results
// afterward.
//
// This is NOT scripts/bake.js — that harness (still there, still useful)
// runs the CURRENT prompt raw across models with no judge pass at all,
// for a quick voice/format read. This one runs each system's FULL
// pipeline (generation, safety, and — for the v3 systems — the taste
// judge too) because the whole point here is comparing what a visitor
// would actually be shown, not raw model output.
//
//   LLM_API_KEY=...  node scripts/bake-blind.js
//   BAKE_BLIND_SYSTEMS=B,C  node scripts/bake-blind.js   # subset, for a cheaper test run
//   BAKE_BLIND_LIMIT=20     node scripts/bake-blind.js   # first N inputs only
//   BAKE_ASTRA=1            node scripts/bake-blind.js   # adds system E if gpt-6-astra is on OpenRouter
//
// Cost/time note: this is not cheap. Four systems × 200 inputs, each
// input costing a generation call plus (for B/C/D) an expensive taste-
// judge call, is a real bill and a real wait — use BAKE_BLIND_SYSTEMS/
// BAKE_BLIND_LIMIT for a smaller pass first. Results are written
// incrementally to bake/results/<system>.json (flushed after every
// input), so an interrupted run doesn't lose what it already paid for —
// re-running overwrites that file from scratch, it doesn't resume.

const fs = require("fs");
const path = require("path");
const { fetch, Agent } = require("undici");

const { callLLM, BASE_URL, CHAT_URL } = require("../lib/llm");
const { extractArray, normalizeItem, isRefusal, filterLines } = require("../lib/postprocess");
const { judgeOneLine, judgeCandidates } = require("../lib/judge");
const { composeDraft } = require("../lib/compose");

// System A's full v2 pipeline — frozen, never the live lib/ versions (see
// lib/legacy/prompt-v2.js's own header comment).
const legacyPrompt = require("../lib/legacy/prompt-v2");
const legacyPost = require("../lib/legacy/postprocess-v2");
const legacyJudge = require("../lib/legacy/judge-v2");

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
const RESULTS_DIR = path.join(__dirname, "..", "bake", "results");
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const ALL_INPUTS = fs.readFileSync(INPUTS_PATH, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const LIMIT = process.env.BAKE_BLIND_LIMIT ? parseInt(process.env.BAKE_BLIND_LIMIT, 10) : ALL_INPUTS.length;
const INPUTS = ALL_INPUTS.slice(0, LIMIT);

// The four systems from the brief. `kind` picks which pipeline below
// (runLegacyInput vs runV3Input) actually handles it; `model` is the one
// thing that varies between B/C/D — same v3 lanes prompt, same taste
// judge, different generator.
const SYSTEMS = [
  { key: "A", label: "legacy hermes (v2 four-shape) + mistral-small safety judge", kind: "legacy", model: "nousresearch/hermes-4-405b" },
  { key: "B", label: "hermes (v3 lanes) + sol taste judge", kind: "v3", model: "nousresearch/hermes-4-405b" },
  { key: "C", label: "gpt-5.4 (v3 lanes) + sol taste judge", kind: "v3", model: "openai/gpt-5.4" },
  { key: "D", label: "sol (v3 lanes) + sol taste judge", kind: "v3", model: "openai/gpt-5.6-sol" }
];

const LLM_TIMEOUT_MS = 12000;
const legacyDispatcher = new Agent({
  connect: { timeout: LLM_TIMEOUT_MS },
  headersTimeout: LLM_TIMEOUT_MS,
  bodyTimeout: LLM_TIMEOUT_MS
});

// lib/llm.js's callLLM is hardwired to lib/prompt.js's v3 request builders
// — exactly what systems B/C/D want (see runV3Input below), but wrong for
// system A, which needs lib/legacy/prompt-v2.js's OLD buildRequest
// instead. This is that same HTTP mechanics, parameterized by which
// builder to use, so system A can run the real frozen v2 prompt rather
// than whatever v3 currently asks for.
async function callWithBuilder(model, sentText, buildFn) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, LLM_TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://almostsent.app",
        "X-Title": "almost sent"
      },
      body: JSON.stringify(buildFn(model, sentText)),
      signal: controller.signal,
      dispatcher: legacyDispatcher
    });
    if (!res.ok) {
      const errBody = await res.text().catch(function () { return ""; });
      throw new Error("llm " + res.status + ": " + errBody.slice(0, 200));
    }
    const data = await res.json();
    if (data && data.error) throw new Error("llm: " + (data.error.message || "error"));
    const choice = data && data.choices && data.choices[0];
    if (!choice) throw new Error("no choices returned");
    let text = choice.message && choice.message.content;
    if (Array.isArray(text)) text = text.map(function (p) { return (p && p.text) || ""; }).join(" ");
    return { text: String(text || "").trim(), finishReason: choice.finish_reason };
  } finally {
    clearTimeout(timer);
  }
}

// System A: v2's full pipeline, unchanged — full-batch generate (six
// lines across the four active v2 shapes), keyword wall, safety-judge
// every survivor (mistral-small, v2's own judgeOneLine), take the first
// three survivors in v2's own orderByShape order. No taste judge — v2
// never had one, and this system exists specifically to show what v2
// actually shipped, not an upgraded version of it.
async function runLegacyInput(model, input) {
  try {
    const { text, finishReason } = await callWithBuilder(model, input, legacyPrompt.buildRequest);
    const parsed = legacyPost.extractArray(text);
    if (!parsed) return { input: input, top3: [], note: finishReason === "length" ? "hit token limit" : "unparsable response" };
    const items = parsed.map(legacyPost.normalizeItem);
    if (legacyPost.isRefusal(items)) return { input: input, top3: [], note: "refused" };
    const filtered = legacyPost.filterLines(items, input);
    if (!filtered.kept.length) return { input: input, top3: [], note: "all lines filtered" };
    const safetyVerdicts = await Promise.all(filtered.kept.map(function (item) {
      return legacyJudge.judgeOneLine(apiKey, composeDraft(input, item.text));
    }));
    const safe = filtered.kept.filter(function (item, i) { return safetyVerdicts[i].verdict !== true; });
    if (!safe.length) return { input: input, top3: [], note: "all lines flagged" };
    const ordered = legacyPost.orderByShape(safe);
    return { input: input, top3: ordered.slice(0, 3).map(function (item) { return { tag: item.shape, text: composeDraft(input, item.text) }; }) };
  } catch (err) {
    return { input: input, top3: [], note: "error: " + (err && err.message) };
  }
}

// Systems B/C/D: v3's real pipeline — the primary (eight-lane) generator
// call only, no wildcard (raunchy/gross is always hermes in production
// regardless of which primary model is under test here, so it isn't part
// of what these three systems are actually comparing). Safety-judges
// every survivor exactly like api/draft.js does, then the real taste
// judge (judgeCandidates, JUDGE_MODEL — sol by default) gates and ranks
// what's left. A failed taste call falls back to input order, same
// graceful-degradation api/draft.js has, rather than failing this input
// out of the run entirely.
async function runV3Input(model, input) {
  try {
    const { text, finishReason } = await callLLM(apiKey, model, input);
    const parsed = extractArray(text);
    if (!parsed) return { input: input, top3: [], note: finishReason === "length" ? "hit token limit" : "unparsable response" };
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return { input: input, top3: [], note: "refused" };
    const filtered = filterLines(items, input);
    if (!filtered.kept.length) return { input: input, top3: [], note: "all lines filtered" };
    const safetyVerdicts = await Promise.all(filtered.kept.map(function (item) {
      return judgeOneLine(apiKey, composeDraft(input, item.text));
    }));
    const safe = filtered.kept.filter(function (item, i) { return safetyVerdicts[i].verdict !== true; });
    if (!safe.length) return { input: input, top3: [], note: "all lines flagged" };
    const taste = await judgeCandidates(apiKey, input, safe);
    const ranked = taste.ok ? taste.ranked : safe;
    return { input: input, top3: ranked.slice(0, 3).map(function (item) { return { tag: item.lane, text: composeDraft(input, item.text) }; }), note: taste.ok ? "" : "taste judge failed (" + taste.reason + "), input order used" };
  } catch (err) {
    return { input: input, top3: [], note: "error: " + (err && err.message) };
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// One system at a time, one input at a time — same "don't hammer rate
// limits" reasoning as scripts/bake.js's own sequential-with-a-gap
// approach, just applied per input instead of per model since each input
// here is a whole pipeline (generation + up to nine judge calls), not one
// bare completion.
async function runSystem(system) {
  const outPath = path.join(RESULTS_DIR, system.key + ".json");
  const results = [];
  for (let i = 0; i < INPUTS.length; i++) {
    const input = INPUTS[i];
    process.stdout.write("  [" + system.key + "] [" + (i + 1) + "/" + INPUTS.length + "] " + input + "\n");
    const row = system.kind === "legacy" ? await runLegacyInput(system.model, input) : await runV3Input(system.model, input);
    results.push(row);
    // Flushed after every input, not just at the end — a run that gets
    // interrupted partway (Ctrl-C, a rate limit, a laptop going to sleep)
    // still has everything it already paid for on disk.
    fs.writeFileSync(outPath, JSON.stringify({
      system: system.key,
      label: system.label,
      model: system.model,
      generatedAt: new Date().toISOString(),
      results: results
    }, null, 2));
    await sleep(500);
  }
  return results;
}

async function main() {
  let systems = SYSTEMS;
  if (process.env.BAKE_ASTRA === "1") {
    try {
      const res = await fetch(BASE_URL + "/models", { headers: { Authorization: "Bearer " + apiKey } });
      const data = res.ok ? await res.json() : null;
      const available = data ? (data.data || []).map(function (m) { return m.id; }) : [];
      if (available.indexOf("openai/gpt-6-astra") !== -1) {
        systems = systems.concat([{ key: "E", label: "gpt-6-astra (v3 lanes) + sol taste judge", kind: "v3", model: "openai/gpt-6-astra" }]);
        console.log("BAKE_ASTRA=1 and openai/gpt-6-astra is available — adding system E.");
      } else {
        console.log("BAKE_ASTRA=1 but openai/gpt-6-astra isn't in OpenRouter's current model list — skipping system E.");
      }
    } catch (err) {
      console.log("BAKE_ASTRA=1 but couldn't check model availability (" + (err && err.message) + ") — skipping system E.");
    }
  }
  if (process.env.BAKE_BLIND_SYSTEMS) {
    const wanted = process.env.BAKE_BLIND_SYSTEMS.split(",").map(function (s) { return s.trim().toUpperCase(); });
    systems = systems.filter(function (s) { return wanted.indexOf(s.key) !== -1; });
  }

  console.log("bake-blind: " + systems.length + " systems × " + INPUTS.length + " inputs");
  systems.forEach(function (s) { console.log("  " + s.key + ": " + s.label + " (" + s.model + ")"); });
  console.log("");

  for (const system of systems) {
    await runSystem(system);
    console.log("  wrote bake/results/" + system.key + ".json");
  }
  console.log("\ndone. Next: open scripts/bake-rate.html to collect blind ratings, then run scripts/bake-tally.js.");
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});

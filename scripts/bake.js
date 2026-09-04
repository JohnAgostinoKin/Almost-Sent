#!/usr/bin/env node
// Runs the 30-input harness through three OpenRouter models and writes
// bake-results.md. Run it three times (temperature is 1.0, so results
// vary) and read the table yourself — this script doesn't pick a winner.
//
//   LLM_API_KEY=...  npm run bake
//   BAKE_MODELS=a,b,c npm run bake      # override the default three models
//
// Requires Node 18+ (uses global fetch). No dependencies.

const fs = require("fs");
const path = require("path");

const { exactMatch } = require("../lib/bank");
const { callLLM, BASE_URL } = require("../lib/llm");
const { extractArray, normalizeItem, isRefusal, filterLines } = require("../lib/postprocess");
const { stallLine } = require("../lib/fallback");
const { composeDraft } = require("../lib/compose");

// This harness only runs the keyword wall (now just slurs and minor-related
// terms, see lib/postprocess.js's WALL_WORDS) — it doesn't run the judge
// pass lib/judge.js adds to the live /api/draft path, so a row here can show
// a line surviving that production would still catch and drop. Read the
// table for voice/format quality, not as a preview of what a real visitor
// would see filtered.

// --- tiny .env loader (no dotenv dependency) --------------------------
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

const DEFAULT_MODELS = [
  "openai/gpt-oss-120b",
  "meta-llama/llama-3.3-70b-instruct",
  "qwen/qwen3-32b"
];
const REQUESTED_MODELS = (process.env.BAKE_MODELS
  ? process.env.BAKE_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODELS
).slice(0, 3);

// The 30-input harness. Mixed length, every relationship type, no
// category label passed — the model has to infer relationship from text.
//
// None of these may duplicate (or closely echo) a "before" example from the
// system prompt's EXAMPLES pool in lib/prompt.js — the model would just be
// pattern matching an example it was already handed the answer to, not
// writing one cold. If you add an input, check it against lib/prompt.js
// first. ("made it home", "thanks for your patience", "let's grab a coffee
// sometime", "you awake", and "love ya" were swapped out for exactly this
// reason when the pool grew to cover the continuation mechanic's four
// shapes — they collided with or closely echoed new pool entries.)
const INPUTS = [
  "k",
  "ok",
  "lol",
  "got your message",
  "back at my place",
  "you busy this weekend",
  "we should catch a movie",
  "congrats on the promotion",
  "text me when you land",
  "how's it going",
  "long day",
  "all good",
  "we'll see",
  "i'll let you know",
  "can't sleep",
  "wish you were here",
  "you mean a lot to me",
  "i haven't reached out in a while",
  "you free to chat",
  "let's circle back on this",
  "as previously discussed",
  "running 10 minutes late",
  "this isn't working out",
  "i'm not mad",
  "do what you want",
  "nice seeing you today",
  "you crossed my mind today",
  "that was fun",
  "morning",
  "we good?"
];

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) {
  console.error("LLM_API_KEY is not set. Put it in .env or export it, then re-run.");
  process.exit(1);
}

function md(cell) {
  return String(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

// --- model availability -------------------------------------------------
// Just informational: fetch what OpenRouter currently serves and print the
// ids so a human can set BAKE_MODELS. No substitution — swapping in a
// "closest name match" has previously landed on a completely wrong class
// of model (a moderation/guard model standing in for a chat model) and
// produced results nobody should read. If a requested model turns out not
// to exist, the call to it fails per-row like any other error and that's
// the correct signal to go fix BAKE_MODELS.
async function listAvailableModels() {
  try {
    const res = await fetch(BASE_URL + "/models", {
      headers: { Authorization: "Bearer " + apiKey }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || []).map((m) => m.id).sort();
  } catch (err) {
    return null;
  }
}

const EMPTY_DROPS = { droppedWords: 0, droppedSuspicious: 0, droppedCrutch: 0, droppedWall: 0, droppedScript: 0, droppedOpener: 0, droppedDiversity: 0 };

async function runOneModel(model, input) {
  try {
    const { text, latencyMs, finishReason } = await callLLM(apiKey, model, input);
    const parsed = extractArray(text);
    if (!parsed) {
      const note = finishReason === "length" ? "hit token limit" : "unparsable response";
      return { model, ok: false, lines: [], ...EMPTY_DROPS, latencyMs, note };
    }
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) {
      return { model, ok: false, refused: true, lines: [], ...EMPTY_DROPS, latencyMs, note: "refused" };
    }
    const { kept, droppedWords, droppedSuspicious, droppedCrutch, droppedWall, droppedScript, droppedOpener, droppedDiversity } = filterLines(items, input);
    return {
      model,
      ok: kept.length > 0,
      lines: kept,
      droppedWords,
      droppedSuspicious,
      droppedCrutch,
      droppedWall, droppedScript, droppedOpener, droppedDiversity,
      latencyMs,
      note: kept.length ? "" : "all lines dropped"
    };
  } catch (err) {
    return {
      model,
      ok: false,
      lines: [],
      ...EMPTY_DROPS,
      latencyMs: err.latencyMs || 0,
      note: `error: ${err.message}`
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Diagnostic-only: callLLM's own AbortController-based 12s timeout has been
// observed to not fire — the underlying fetch just never settles, hanging
// the whole process. This is a hard outer backstop, independent of that
// mechanism: if a model call hasn't resolved within WATCHDOG_MS, stop
// waiting on it and record a watchdog-kill row instead so the run can keep
// going. The abandoned promise is left to settle (or not) on its own.
const WATCHDOG_MS = 60000;
function withWatchdog(promise, model) {
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        model,
        ok: false,
        lines: [],
        ...EMPTY_DROPS,
        latencyMs: WATCHDOG_MS,
        note: `watchdog kill after ${WATCHDOG_MS}ms`,
        watchdogKilled: true
      });
    }, WATCHDOG_MS);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

// Models are called one at a time with a 1-second gap between every call,
// never in parallel — Groq's 8000 TPM cap made parallel calls fall over
// mid-run, and a fixed gap between sequential calls is the version of this
// that keeps working regardless of which provider's limits are in play.
async function runInput(models, input) {
  const bankHit = exactMatch(input);
  if (bankHit) {
    return {
      input,
      results: models.map((model) => ({
        model,
        ok: true,
        lines: [{ shape: "bank", text: bankHit }],
        ...EMPTY_DROPS,
        latencyMs: 0,
        note: "bank hit — model not called"
      })),
      source: "bank",
      why: "exact bank match"
    };
  }

  const results = [];
  for (const model of models) {
    results.push(await withWatchdog(runOneModel(model, input), model));
    await sleep(1000);
  }
  const usable = results.filter((r) => r.ok);

  if (usable.length > 0) {
    return { input, results, source: "model", why: `${usable.length}/${models.length} models returned usable lines` };
  }

  const stall = stallLine();
  return { input, results, source: "stall", why: `stall line: "${stall}"` };
}

async function main() {
  const MODELS = REQUESTED_MODELS;

  const available = await listAvailableModels();
  if (available) {
    console.log(`${available.length} models available at ${BASE_URL}/models — set BAKE_MODELS from these:`);
    available.forEach((id) => console.log("  " + id));
    const missing = MODELS.filter((m) => !available.includes(m));
    if (missing.length) {
      console.log("");
      missing.forEach((m) => console.log(`  ! "${m}" is not in that list — the call below will likely fail, not get substituted.`));
    }
  } else {
    console.log(`couldn't fetch ${BASE_URL}/models — proceeding with the requested models as-is.`);
  }
  console.log("");

  console.log(`bake-off: ${MODELS.length} models × ${INPUTS.length} inputs`);
  console.log(MODELS.map((m, i) => `  ${["A", "B", "C"][i]}: ${m}`).join("\n"));
  console.log("");

  const rows = [];
  for (let i = 0; i < INPUTS.length; i++) {
    const input = INPUTS[i];
    process.stdout.write(`  [${i + 1}/${INPUTS.length}] ${input}\n`);
    const row = await runInput(MODELS, input);
    rows.push(row);
  }

  // --- summary ----------------------------------------------------------
  const summary = {};
  for (const model of MODELS) summary[model] = { stalled: 0, droppedWords: 0, droppedSuspicious: 0, droppedCrutch: 0, droppedWall: 0, droppedScript: 0, droppedOpener: 0, droppedDiversity: 0, latencies: [] };

  for (const row of rows) {
    for (const r of row.results) {
      const s = summary[r.model];
      s.droppedWords += r.droppedWords || 0;
      s.droppedSuspicious += r.droppedSuspicious || 0;
      s.droppedCrutch += r.droppedCrutch || 0;
      s.droppedWall += r.droppedWall || 0;
      s.droppedScript += r.droppedScript || 0;
      s.droppedOpener += r.droppedOpener || 0;
      s.droppedDiversity += r.droppedDiversity || 0;
      if (r.latencyMs) s.latencies.push(r.latencyMs);
      if (!r.ok) s.stalled++;
    }
  }

  console.log("\n--- summary ---");
  for (const model of MODELS) {
    const s = summary[model];
    const avg = s.latencies.length
      ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
      : 0;
    console.log(
      `${model}: ${s.stalled}/${rows.length} stalled, ${s.droppedWords} lines dropped for word count, ${s.droppedSuspicious} dropped as suspicious, ${s.droppedCrutch} dropped as crutches, ${s.droppedWall} dropped as wall, ${s.droppedScript} dropped as non-latin script, ${s.droppedOpener} dropped as no-opener, ${s.droppedDiversity} dropped for diversity, avg latency ${avg}ms`
    );
  }
  const bankRows = rows.filter((r) => r.source === "bank").length;
  const modelRows = rows.filter((r) => r.source === "model").length;
  const stallRows = rows.filter((r) => r.source === "stall").length;
  console.log(`source split: bank=${bankRows} model=${modelRows} stall=${stallRows}`);

  // --- bake-results.md ----------------------------------------------------
  // Cells show the full composed draft (sent + continuation), not the
  // continuation alone — see lib/compose.js — so the table reads as
  // complete drafts the way the page renders them, not fragments.
  const header = `| input | ${["A", "B", "C"].slice(0, MODELS.length).map((l, i) => `${l}: ${MODELS[i]}`).join(" | ")} | source | why |\n`;
  const divider = `|---|${MODELS.map(() => "---").join("|")}|---|---|\n`;
  let table = header + divider;
  for (const row of rows) {
    const cells = row.results.map((r) => {
      if (r.refused) return "REFUSE";
      if (!r.ok) return `_${r.note}_`;
      return r.lines.map((l) => `[${l.shape}] "${composeDraft(row.input, l.text)}"`).join("<br>");
    });
    table += `| ${md(row.input)} | ${cells.map(md).join(" | ")} | ${row.source} | ${md(row.why)} |\n`;
  }

  let summaryMd = "\n## Summary\n\n";
  summaryMd += "| model | stall rows | dropped (words) | dropped (suspicious) | dropped (crutch) | dropped (wall) | dropped (non-latin script) | dropped (no opener) | dropped (diversity) | avg latency |\n|---|---|---|---|---|---|---|---|---|---|\n";
  for (const model of MODELS) {
    const s = summary[model];
    const avg = s.latencies.length
      ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
      : 0;
    summaryMd += `| ${model} | ${s.stalled}/${rows.length} | ${s.droppedWords} | ${s.droppedSuspicious} | ${s.droppedCrutch} | ${s.droppedWall} | ${s.droppedScript} | ${s.droppedOpener} | ${s.droppedDiversity} | ${avg}ms |\n`;
  }
  summaryMd += `\nSource split across all ${rows.length} inputs: **bank** ${bankRows}, **model** ${modelRows}, **stall** ${stallRows}.\n`;
  summaryMd += `\n"k", "sounds good", "made it home", and "on my way" are bank entries (the page's hero examples must be deterministic), so ${bankRows} of the ${rows.length} rows never call a model at all. Read "source: model" against the reachable ceiling of ${rows.length - bankRows}/${rows.length} non-bank rows, not the raw ${rows.length}.\n`;
  summaryMd += "\nTemperature is 1.0 — run this three times before deciding anything. This script does not pick a winner; read the table.\n";

  const out = `# bake-off results\n\nRun at ${new Date().toISOString()}\n\n${table}${summaryMd}`;
  fs.writeFileSync(path.join(__dirname, "..", "bake-results.md"), out);
  console.log("\nwrote bake-results.md");
}

main()
  .then(() => process.exit(0)) // a watchdog-killed call may leave a fetch that never settles; don't wait on it
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

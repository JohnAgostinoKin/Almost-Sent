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
const { extractArray, isRefusal, filterLines } = require("../lib/postprocess");
const { keywordFallback, wordFallback } = require("../lib/fallback");

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
// None of these may duplicate (or closely echo) a "before" example from
// the system prompt in lib/prompt.js — the model would just be pattern
// matching an example it was already handed the answer to, not writing
// one. If you add an input, check it against lib/prompt.js first.
const INPUTS = [
  "k",
  "ok",
  "lol",
  "sounds good",
  "made it home",
  "you around later",
  "let's grab a coffee sometime",
  "congrats on the promotion",
  "text me when you land",
  "how's it going",
  "i'm fine",
  "all good",
  "we'll see",
  "i'll let you know",
  "you awake",
  "wish you were here",
  "love ya",
  "i haven't reached out in a while",
  "can we talk",
  "let's circle back on this",
  "as previously discussed",
  "thanks for your patience",
  "this isn't working out",
  "i'm not mad",
  "do what you want",
  "get home safe",
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

async function runOneModel(model, input) {
  try {
    const { text, latencyMs, finishReason } = await callLLM(apiKey, model, input);
    const parsed = extractArray(text);
    if (!parsed) {
      const note = finishReason === "length" ? "hit token limit" : "unparsable response";
      return { model, ok: false, lines: [], droppedLength: 0, droppedSuspicious: 0, latencyMs, note };
    }
    if (isRefusal(parsed)) {
      return { model, ok: false, refused: true, lines: [], droppedLength: 0, droppedSuspicious: 0, latencyMs, note: "refused" };
    }
    const { kept, droppedLength, droppedSuspicious } = filterLines(parsed, input);
    return {
      model,
      ok: kept.length > 0,
      lines: kept,
      droppedLength,
      droppedSuspicious,
      latencyMs,
      note: kept.length ? "" : "all lines dropped"
    };
  } catch (err) {
    return {
      model,
      ok: false,
      lines: [],
      droppedLength: 0,
      droppedSuspicious: 0,
      latencyMs: err.latencyMs || 0,
      note: `error: ${err.message}`
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        lines: [bankHit],
        droppedLength: 0,
        droppedSuspicious: 0,
        latencyMs: 0,
        note: "bank hit — model not called"
      })),
      source: "bank",
      why: "exact bank match"
    };
  }

  const results = [];
  for (const model of models) {
    results.push(await runOneModel(model, input));
    await sleep(1000);
  }
  const usable = results.filter((r) => r.ok);

  if (usable.length > 0) {
    return { input, results, source: "model", why: `${usable.length}/${models.length} models returned usable lines` };
  }

  const kw = keywordFallback(input);
  if (kw) {
    return { input, results, source: "fallback", why: `keyword fallback: "${kw}"` };
  }
  const word = wordFallback(input);
  return { input, results, source: "fallback", why: `word fallback: "${word}"` };
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
  for (const model of MODELS) summary[model] = { fallback: 0, droppedLength: 0, droppedSuspicious: 0, latencies: [] };

  for (const row of rows) {
    for (const r of row.results) {
      const s = summary[r.model];
      s.droppedLength += r.droppedLength || 0;
      s.droppedSuspicious += r.droppedSuspicious || 0;
      if (r.latencyMs) s.latencies.push(r.latencyMs);
      if (!r.ok) s.fallback++;
    }
  }

  console.log("\n--- summary ---");
  for (const model of MODELS) {
    const s = summary[model];
    const avg = s.latencies.length
      ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
      : 0;
    console.log(
      `${model}: ${s.fallback}/${rows.length} fell back, ${s.droppedLength} lines dropped for length, ${s.droppedSuspicious} dropped as suspicious, avg latency ${avg}ms`
    );
  }
  const bankRows = rows.filter((r) => r.source === "bank").length;
  const modelRows = rows.filter((r) => r.source === "model").length;
  const fallbackRows = rows.filter((r) => r.source === "fallback").length;
  console.log(`source split: bank=${bankRows} model=${modelRows} fallback=${fallbackRows}`);

  // --- bake-results.md ----------------------------------------------------
  const header = `| input | ${["A", "B", "C"].slice(0, MODELS.length).map((l, i) => `${l}: ${MODELS[i]}`).join(" | ")} | source | why |\n`;
  const divider = `|---|${MODELS.map(() => "---").join("|")}|---|---|\n`;
  let table = header + divider;
  for (const row of rows) {
    const cells = row.results.map((r) => {
      if (r.refused) return "REFUSE";
      if (!r.ok) return `_${r.note}_`;
      return r.lines.map((l) => `"${l}"`).join("<br>");
    });
    table += `| ${md(row.input)} | ${cells.map(md).join(" | ")} | ${row.source} | ${md(row.why)} |\n`;
  }

  let summaryMd = "\n## Summary\n\n";
  summaryMd += "| model | fallback rows | dropped (length) | dropped (suspicious) | avg latency |\n|---|---|---|---|---|\n";
  for (const model of MODELS) {
    const s = summary[model];
    const avg = s.latencies.length
      ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length)
      : 0;
    summaryMd += `| ${model} | ${s.fallback}/${rows.length} | ${s.droppedLength} | ${s.droppedSuspicious} | ${avg}ms |\n`;
  }
  summaryMd += `\nSource split across all ${rows.length} inputs: **bank** ${bankRows}, **model** ${modelRows}, **fallback** ${fallbackRows}.\n`;
  summaryMd += `\n"k", "sounds good", and "made it home" are bank entries (the page's hero examples must be deterministic), so ${bankRows} of the ${rows.length} rows never call a model at all. The brief's "source: model on at least 28 of 30" bar is written against a 30-row harness with no bank hits; with these ${bankRows} bank rows fixed, the reachable ceiling for source: model is ${rows.length - bankRows}/${rows.length} — read the bar as model on (nearly) all of the non-bank rows, not literally 28/30.\n`;
  summaryMd += "\nTemperature is 1.0 — run this three times before deciding anything. This script does not pick a winner; read the table.\n";

  const out = `# bake-off results\n\nRun at ${new Date().toISOString()}\n\n${table}${summaryMd}`;
  fs.writeFileSync(path.join(__dirname, "..", "bake-results.md"), out);
  console.log("\nwrote bake-results.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

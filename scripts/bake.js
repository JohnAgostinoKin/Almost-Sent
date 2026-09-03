#!/usr/bin/env node
// Runs the 30-input harness through three Groq models and writes
// bake-results.md. Run it three times (temperature is 1.0, so results
// vary) and read the table yourself — this script doesn't pick a winner.
//
//   GROQ_API_KEY=...  npm run bake
//   BAKE_MODELS=a,b,c npm run bake      # override the default three models
//
// Requires Node 18+ (uses global fetch). No dependencies.

const fs = require("fs");
const path = require("path");

const { exactMatch } = require("../lib/bank");
const { callGroq } = require("../lib/groq");
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
  "llama-3.3-70b-versatile",
  "qwen/qwen3-32b"
];
const REQUESTED_MODELS = (process.env.BAKE_MODELS
  ? process.env.BAKE_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
  : DEFAULT_MODELS
).slice(0, 3);

// The 30-input harness. Mixed length, every relationship type, no
// category label passed — the model has to infer relationship from text.
const INPUTS = [
  "k",
  "ok",
  "lol",
  "sounds good",
  "made it home",
  "just checking in",
  "we should catch up soon",
  "happy birthday!",
  "drive safe",
  "how are you",
  "i'm fine",
  "no worries",
  "we'll see",
  "i'll let you know",
  "you up",
  "miss you",
  "love you too",
  "sorry i've been distant",
  "can we talk",
  "let's circle back on this",
  "per my last email",
  "thanks for your patience",
  "it's not you it's me",
  "i'm not mad",
  "do what you want",
  "get home safe",
  "thinking of you",
  "that was fun",
  "morning",
  "we good?"
];

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY is not set. Put it in .env or export it, then re-run.");
  process.exit(1);
}

function md(cell) {
  return String(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

// --- model availability -------------------------------------------------
// Groq's lineup changes. Check what's actually there today and swap in the
// closest current equivalent for anything missing, rather than failing the
// whole run or silently reporting errors for a model that no longer exists.
async function resolveModels(requested) {
  let available = null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: "Bearer " + apiKey }
    });
    if (res.ok) {
      const data = await res.json();
      available = new Set((data.data || []).map((m) => m.id));
    }
  } catch (err) {
    // Can't reach the models endpoint — proceed with what was asked for
    // and let the actual completion calls surface any problem per-row.
  }
  if (!available || !available.size) return { models: requested, notes: [] };

  const notes = [];
  const resolved = requested.map((model) => {
    if (available.has(model)) return model;
    const tokens = model.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 2);
    let sub = [...available].find((id) => {
      const idl = id.toLowerCase();
      return tokens.some((t) => idl.includes(t));
    });
    if (!sub) sub = [...available][0];
    notes.push(`"${model}" is not on Groq today — substituting "${sub}".`);
    return sub;
  });
  return { models: resolved, notes };
}

async function runOneModel(model, input) {
  try {
    const { text, latencyMs, finishReason } = await callGroq(apiKey, model, input);
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

  const results = await Promise.all(models.map((model) => runOneModel(model, input)));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { models: MODELS, notes: substitutions } = await resolveModels(REQUESTED_MODELS);

  console.log(`bake-off: ${MODELS.length} models × ${INPUTS.length} inputs`);
  console.log(MODELS.map((m, i) => `  ${["A", "B", "C"][i]}: ${m}`).join("\n"));
  if (substitutions.length) {
    console.log("");
    substitutions.forEach((n) => console.log("  ! " + n));
  }
  console.log("");

  const rows = [];
  for (let i = 0; i < INPUTS.length; i++) {
    const input = INPUTS[i];
    process.stdout.write(`  [${i + 1}/${INPUTS.length}] ${input}\n`);
    const row = await runInput(MODELS, input);
    rows.push(row);
    if (i < INPUTS.length - 1) await sleep(250); // be polite to the rate limit
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
  summaryMd += "\nTemperature is 1.0 — run this three times before deciding anything. This script does not pick a winner; read the table.\n";

  const substitutionsMd = substitutions.length
    ? "\n## Model substitutions\n\n" + substitutions.map((n) => `- ${n}`).join("\n") + "\n"
    : "";

  const out = `# bake-off results\n\nRun at ${new Date().toISOString()}\n${substitutionsMd}\n${table}${summaryMd}`;
  fs.writeFileSync(path.join(__dirname, "..", "bake-results.md"), out);
  console.log("\nwrote bake-results.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

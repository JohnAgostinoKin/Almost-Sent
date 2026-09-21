// api/cron/precompute.js
//
// Nightly cache pre-warm (see vercel.json's `crons` entry). Takes the
// most-pasted texts in the inbox (inbox.hits — a repeat-paste counter, see
// scripts/precompute-schema.sql), runs each through the FULL draft pipeline
// (api/draft.js's runPrecompute — same keyword block, crisis check, safety,
// taste judge, regen, position selection as a live request) with
// openai/gpt-6-astra as the generator, and stores the result in the
// `precomputed` table with a 7-day TTL and gen_model "astra". api/draft.js
// serves a hit from there before generating anything, and index.html logs
// gen_model in draft_shown's meta.
//
// Astra is far too slow for a live request (~20s p95), which is exactly why
// it runs here: nobody is waiting on it.
//
// Spend cap: PRECOMPUTE_BUDGET_USD per UTC day (default 5), enforced against
// a ledger row in the `precomputed` table so it holds across invocations,
// not just within one. What's counted is OpenRouter's own reported cost for
// every generator call (usage.cost), plus JUDGE_ALLOWANCE_USD per text for
// the safety + taste judge calls, which don't report cost back here — that
// part is an estimate, deliberately on the high side. In-flight texts are
// reserved for at their running-average cost, so concurrency can't blow far
// past the cap.
//
// Also stops launching new texts near the function's own time limit
// (PRECOMPUTE_WALL_MS), and skips any text that already has a fresh
// precomputed row — so a night that runs out of budget or time just picks up
// the rest the next night, and 7 days of nightly runs converge on the whole
// top list staying warm.
//
// A result is NOT stored if it fell back to the mistral fallback model
// (it wouldn't be an Astra result), if any safety-judge call failed open, or
// unless the crisis pre-check actually ran and said "clear" (it fails open on
// a model error, which a single live request can tolerate but a 7-day cache
// must not: a distress text would then serve cached jokes instead of the 988
// screen to everyone who pastes it).
//
// Refuses to run unless CRON_SECRET is set (unlike api/cron/cleanup.js,
// which skips the guard when it's unset): this endpoint spends money.

const { runPrecompute } = require("../draft");
const { normalizeBefore } = require("../../lib/prompt");
const { putPrecomputed, freshKeys, readSpend, writeSpend } = require("../../lib/precomputed");

const ASTRA_MODEL = "openai/gpt-6-astra";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JUDGE_ALLOWANCE_USD = 0.015;
const DEFAULT_EST_ITEM_USD = 0.1; // until 3 texts have finished and a real average exists
// A text launched this close to the wall limit might not finish; see WALL_MS.
const LAUNCH_CUTOFF_BEFORE_WALL_MS = 90 * 1000;

function num(name, dflt) {
  const n = Number(process.env[name]);
  return isFinite(n) && n > 0 ? n : dflt;
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === "Bearer " + secret;
}

async function topInbox(limit) {
  const url = process.env.SUPABASE_URL.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(url + "/rest/v1/inbox?select=sent,hits&order=hits.desc,created_at.desc&limit=" + limit, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  if (!res.ok) {
    const body = await res.text().catch(function () { return ""; });
    throw new Error("inbox query failed: " + res.status + " " + body.slice(0, 200));
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.LLM_API_KEY) {
    res.status(200).json({ ok: false, reason: "not configured" });
    return;
  }

  const started = Date.now();
  const budget = num("PRECOMPUTE_BUDGET_USD", 5);
  const wallMs = num("PRECOMPUTE_WALL_MS", 270000);
  const concurrency = Math.floor(num("PRECOMPUTE_CONCURRENCY", 4));
  const top = Math.floor(num("PRECOMPUTE_TOP", 200));
  const day = new Date().toISOString().slice(0, 10);

  let rows, fresh, spentBefore;
  try {
    spentBefore = await readSpend(day);
    fresh = await freshKeys();
    if (spentBefore === null || !fresh.ok) {
      console.error("precompute: `precomputed` table not readable (" + fresh.status + ") — run scripts/precompute-schema.sql");
      res.status(200).json({ ok: false, reason: "precomputed table not readable — run scripts/precompute-schema.sql" });
      return;
    }
    rows = await topInbox(top);
  } catch (err) {
    console.error("precompute setup failed: " + (err && err.message));
    res.status(500).json({ ok: false, reason: (err && err.message) || "error" });
    return;
  }

  // Dedupe by the same key api/draft.js looks results up by (two inbox rows
  // can normalize to one), skip anything already fresh or reserved.
  const seen = new Set();
  const todo = [];
  for (const r of rows) {
    const k = normalizeBefore(r.sent);
    if (!k || k.indexOf("__") === 0 || seen.has(k) || fresh.keys.has(k)) continue;
    seen.add(k);
    todo.push(r.sent);
  }

  const tally = { generated: 0, curated: 0, crisis_or_refused: 0, stall: 0, crisis_unverified: 0, fell_back: 0, safety_failed_open: 0, error: 0, store_failed: 0 };
  let spentRun = 0;       // dollars spent this invocation
  let completed = 0;
  let inflight = 0;
  let next = 0;
  let stopped = "done";

  function estItemUsd() { return completed >= 3 ? spentRun / completed : DEFAULT_EST_ITEM_USD; }
  function stopReason() {
    if (spentBefore + spentRun + inflight * estItemUsd() >= budget) return "budget";
    if (Date.now() - started > wallMs - LAUNCH_CUTOFF_BEFORE_WALL_MS) return "wall";
    return null;
  }

  async function worker() {
    while (next < todo.length) {
      const why = stopReason();
      if (why) { if (stopped === "done") stopped = why; return; }
      const sent = todo[next++];
      inflight++;
      const costSink = { usd: 0 };
      try {
        const out = await runPrecompute(sent, { model: ASTRA_MODEL, costSink: costSink });
        const b = out.body || {};
        if (b.crisis || b.refuse) tally.crisis_or_refused++;
        else if (b.source === "curated") tally.curated++;
        else if (/^crisis check/.test(b.stall_reason || "")) tally.crisis_unverified++;
        else if (b.source !== "model" || !b.drafts || !b.drafts.length) tally.stall++;
        else if (!b.safety || b.safety.state !== "clear") tally.crisis_unverified++;
        else if (b.fell_back) tally.fell_back++;
        else if (b.safety_failed_open) tally.safety_failed_open++;
        else {
          const put = await putPrecomputed(sent, {
            drafts: b.drafts, source: "model", why: (b.why || "") + " · precomputed",
            provider: b.provider, weak_lead: b.weak_lead, debug: null, safety: b.safety, gen_model: "astra"
          }, "astra", TTL_MS);
          if (put.ok) tally.generated++; else tally.store_failed++;
        }
      } catch (err) {
        tally.error++;
        console.error("precompute item threw: " + (err && err.message));
      } finally {
        inflight--;
        completed++;
        // Judge allowance only if generation actually ran (an item stopped at
        // the crisis gate never reached the judges).
        spentRun += costSink.usd + (costSink.usd > 0 ? JUDGE_ALLOWANCE_USD : 0);
        // Best-effort: a failed ledger write only loses cross-invocation
        // accounting, this invocation still enforces the cap locally.
        await writeSpend(day, spentBefore + spentRun);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  const summary = {
    ok: true, day: day, candidates: rows.length, already_fresh_or_skipped: rows.length - todo.length,
    attempted: completed, remaining: todo.length - next, stopped: stopped, tally: tally,
    spent_usd: Number((spentBefore + spentRun).toFixed(4)), spent_this_run_usd: Number(spentRun.toFixed(4)),
    budget_usd: budget, elapsed_ms: Date.now() - started
  };
  console.log("precompute: " + JSON.stringify(summary));
  res.status(200).json(summary);
};

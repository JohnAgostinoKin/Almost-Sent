// api/draft.js — v5: one lane pool, one room, GPT-5.4 only on escalation.
//
// v4 fired both generator calls on every request — WILDCARD_MODEL (Hermes)
// writing a fixed seven-candidate plan across shock/raunchy/deranged/
// gross/wildcard, GENERATOR_MODEL (GPT-5.4) writing confession/dark (plus
// absurd on an escalation refetch) — racing the same soft deadline. v5
// moved GPT-5.4 to escalation-only: runGenerationRound below no longer
// calls GENERATOR_MODEL at all unless `escalate` is true, so a first-show
// request is one real model call, not two — that part hasn't changed
// since. Which lanes Hermes writes on the first-show side has, twice: v5
// first narrowed the room to raunchy/gross only (too far — every pool
// collapsed into near-identical propositions, see lib/prompt.js's own
// header), then restored shock/raunchy/deranged/gross as two distinct
// three-candidate calls with raunchy gated by invitation. See lib/
// prompt.js's own header for the current lane shape and why.
//
// One call, though, meant one BIG call — writing every candidate in a
// single request left nothing partial for the soft deadline (below) to
// fall back to; it was one slow call or nothing. runGenerationRound fires
// Hermes as TWO parallel calls instead (wildcardA/wildcardB, see lib/
// prompt.js's WILDCARD_LANE_PLAN_A/_B — different lane sets, not the same
// lanes split in half), each faster than one big call would be, merged
// back into a single `wildcard` result before safety/taste ever sees it —
// every other consumer of `wildcard` in this file is unaffected. On an
// escalation refetch, GENERATOR_MODEL joins as a third concurrent call,
// writing confession/dark/absurd for the first time — same soft-deadline
// race as before, just with three calls now instead of two on that path
// (still exactly one call, the resolved zero-candidate stub, on a
// first-show request).
//
// A later latency pass shrank Hermes' own per-call count (three
// candidates a call, not four — lib/prompt.js's own header has the
// current split), lowered GENERATION_SOFT_DEADLINE_MS to 3500ms, and
// capped the judged candidate pool at JUDGED_POOL_CAP on an escalation
// refetch specifically — GENERATOR_MODEL's own candidates plus a large
// straggler cache could otherwise stack on top of a full fresh Hermes
// batch, taking safety+taste well past what a "make it worse" tap should
// cost. Stragglers only backfill the gap now (fresh generation short of
// the cap), never pile on top of a full batch — see runGenerationRound's
// own comment on JUDGED_POOL_CAP for the exact rule.
//
// Selection past generation is still two separate jobs, run CONCURRENTLY
// on the full candidate set rather than one gating the other: SAFETY
// (lib/judge.js's judgeOneLine, cheap model, one call per candidate)
// checks every candidate for anything that shouldn't ship at all; TASTE
// (lib/judge.js's judgeCandidates, expensive model, split into two
// parallel batches) gates every candidate on five hard checks then scores
// what's left on REACTION now, not craft — see lib/judge.js's own header
// for why. Once BOTH resolve, any candidate safety flagged is removed
// from the ranking regardless of what taste made of it. A failed taste
// call falls back to fixed lane order rather than blocking the response
// on a second expensive call.
//
// v4 adds one more hard gate past taste's own five (see the v4 addendum,
// section F): position 1 must score reaction >= REACTION_LEAD_GATE. A
// weak first round (either this gate or the pre-existing q-based
// REGEN_THRESHOLD) triggers the same one-extra-round regenerate-if-weak
// v3 already had; if the second round STILL doesn't clear the reaction
// gate, this ships the best available anyway rather than failing a
// request that already succeeded once — but logs weak_lead:true rather
// than shipping silently, per the addendum's own instruction.

const { norm } = require("../lib/normalize");
const { callLLM } = require("../lib/llm");
const { GENERATOR_MODEL, WILDCARD_MODEL, WILDCARD_LANE_PLAN_A, WILDCARD_LANE_PLAN_B, primaryLanePlan, ALL_LANES, normalizeBefore } = require("../lib/prompt");
const {
  extractPremiseCandidates, normalizeItem, isRefusal, filterLines, describeDrops, createDiversityTracker
} = require("../lib/postprocess");
const { judgeOneLine, judgeCandidates, judgePairwise } = require("../lib/judge");
const { composeDraft } = require("../lib/compose");
const { stallLine } = require("../lib/fallback");
const { classifyBlock } = require("../lib/block");
const { checkCrisis } = require("../lib/crisis");
const { curatedLeadFor } = require("../lib/curated");
const { createLimiter } = require("../lib/rateLimit");
const { maskPII } = require("../lib/mask");
const { waitUntil } = require("@vercel/functions");

// Captured once, the instant this module is first loaded into a container
// (a cold start, or a deploy) — never again after that on a warm container,
// since require() caches the module. t_cold (computed at the top of the
// handler below) is the gap between that moment and this particular
// request's handler actually running.
const MODULE_LOADED_AT = Date.now();

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Soft deadline on the two generator calls (see runGenerationRound's
// GENERATION_SOFT_DEADLINE_MS below): a call still running past the
// deadline isn't cancelled — a fetch already in flight keeps running
// either way — it just isn't waited on for THIS response. This module-
// level Map is where its eventual candidates land instead, keyed by
// normalizeBefore(sent), so a follow-up "make it worse" request for the
// SAME text (escalate:true — see the handler) can pick them up as bonus
// candidates rather than that generation call's cost going to waste.
// One-shot: takeStragglers both reads and clears an entry, so the same
// stragglers never get reused across two different escalation taps.
// Lives only as long as this container stays warm, same best-effort
// caveat as MODULE_LOADED_AT above — a cold start (or the entry simply
// expiring) just means an escalation request finds nothing here and
// generates fresh, exactly like today.
const STRAGGLER_TTL_MS = 5 * 60 * 1000;
const stragglerCache = new Map();
function cacheStragglers(sent, candidates) {
  if (!candidates.length) return;
  const key = normalizeBefore(sent);
  const existing = stragglerCache.get(key);
  const merged = (existing && existing.expiresAt >= Date.now() ? existing.candidates : []).concat(candidates);
  stragglerCache.set(key, { candidates: merged, expiresAt: Date.now() + STRAGGLER_TTL_MS });
}
function takeStragglers(sent) {
  const key = normalizeBefore(sent);
  const entry = stragglerCache.get(key);
  stragglerCache.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return [];
  return entry.candidates;
}

function newStages() {
  return {
    t_cold: 0,
    t_parse: 0,
    t_block: 0,
    t_wildcardA: 0, // wall-clock of Hermes call A (shock, raunchy, deranged), including any retry/fallback — runs parallel to B and to primary
    t_wildcardB: 0, // wall-clock of Hermes call B (shock, raunchy, gross) — see this file's own header comment for why the room is split into two calls now
    t_wildcard: 0,  // max(t_wildcardA, t_wildcardB) — the wall-clock cost of the Hermes step as a whole, not their sum
    t_primary: 0,  // wall-clock of the GPT-5.4 (clever) generator call, including any retry/fallback — runs parallel to both Hermes halves
    t_judge: 0,    // wall-clock of safety+taste running CONCURRENTLY (see the handler) — not their sum
    t_pairwise: 0, // the one head-to-head call between the top two by q (see judgePairwise) — 0 when there weren't two real survivors to compare
    t_response: 0
  };
}

function formatStages(s) {
  return "t_cold=" + s.t_cold + "ms t_parse=" + s.t_parse + "ms t_block=" + s.t_block + "ms" +
    " t_wildcardA=" + s.t_wildcardA + "ms t_wildcardB=" + s.t_wildcardB + "ms t_wildcard=" + s.t_wildcard + "ms t_primary=" + s.t_primary + "ms" +
    " t_judge=" + s.t_judge + "ms t_pairwise=" + s.t_pairwise + "ms t_response=" + s.t_response + "ms";
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

// One call to one generator (wildcard/Hermes or primary/GPT-5.4). `kind`
// picks which lib/prompt.js builder callLLM reaches for (see lib/llm.js)
// and is carried into `why`/logs for ?debug=1. Both generators now parse
// the same premise-first {premises, candidates} shape
// (extractPremiseCandidates — see lib/prompt.js's buildWildcardPrompt/
// buildPrimaryPrompt) — v3 only gave this treatment to the primary call;
// v4 applies premise-first to both, since it's a mechanic worth keeping
// regardless of which model or how many lanes a given call is writing
// (see the v4 brief's own "keep from v3" list). `premises` rides on the
// returned result purely for api/draft.js's handler to fold into `debug`
// — never shown to a visitor.
async function callOneGenerator(key, model, sent, kind, genOpts) {
  try {
    const result = await callLLM(key, model, sent, Object.assign({ kind: kind }, genOpts));
    const t_gen = result.latencyMs;
    const provider = result.provider || null;
    console.log("provider (" + kind + "): " + (provider || "unknown") + " (" + model + ")");
    const providerTag = provider ? " [" + provider + "]" : "";
    const parsedObj = extractPremiseCandidates(result.text);
    const parsed = parsedObj && parsedObj.candidates;
    if (!parsed) {
      const why = result.finishReason === "length" ? "hit token limit" : (result.text ? "no json in output" : "empty output");
      console.error("parse failure (" + kind + ", " + why + ") model=" + model + " raw=" + JSON.stringify(String(result.text || "").slice(0, 800)));
      return { lines: [], why: why + providerTag, provider: provider, reason: "unparsable", t_gen: t_gen, premises: null };
    }
    const premises = parsedObj.premises.length ? parsedObj.premises : null;
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return { lines: [], skip: true, t_gen: t_gen, premises: premises };
    const filtered = filterLines(items, sent);
    const drops = describeDrops(filtered);
    if (!filtered.kept.length) {
      return { lines: [], why: (drops || "all " + items.length + " filtered") + providerTag, provider: provider, reason: "filtered", debugLines: filtered.all, t_gen: t_gen, premises: premises };
    }
    const why = "ok, kept " + filtered.kept.length + (drops ? " — " + drops : "") + providerTag;
    return { lines: filtered.kept, why: why, provider: provider, debugLines: filtered.all, t_gen: t_gen, premises: premises };
  } catch (err) {
    return { lines: [], why: /timeout/i.test(err.message) ? "timed out" : err.message, provider: null, reason: "error", premises: null };
  }
}

function tagModel(result, model, note) {
  if (result.why) result.why = result.why + " · model: " + model + (note ? " (" + note + ")" : "");
  return result;
}

// Same retry-then-fallback shape as v3's own: every line filtered gets one
// retry on the SAME model (temperature is 1.0, so a second draw is often
// clean even when the first wasn't); an outright refusal, parse failure,
// or thrown error gets one attempt on FALLBACK_MODEL instead — a
// different provider entirely from either GENERATOR_MODEL or
// WILDCARD_MODEL, so a bad day for one upstream doesn't take out both
// attempts.
const FALLBACK_MODEL = "mistralai/mistral-large-2512";
async function runGenerator(key, model, sent, kind, genOpts) {
  const first = await callOneGenerator(key, model, sent, kind, genOpts);
  if (!first.skip && !first.lines.length && first.reason === "filtered") {
    return tagModel(await callOneGenerator(key, model, sent, kind, genOpts), model, "retry");
  }
  if (first.skip || first.reason === "error" || first.reason === "unparsable") {
    return tagModel(await callOneGenerator(key, FALLBACK_MODEL, sent, kind, genOpts), FALLBACK_MODEL, "fallback");
  }
  return tagModel(first, model, null);
}

const limited = createLimiter();

// Phone numbers and email addresses are masked before either the dedupe key
// or the stored text is built, so neither survives even though norm() itself
// doesn't strip them. Shared by remember() and forget() below — both need
// the exact same key for a given `sent`, or forget() could miss the row
// remember() just wrote (or is about to).
function dedupeKey(sent) {
  const masked = maskPII(sent);
  return { masked: masked, key: norm(masked) || masked.trim() };
}

// Fires via waitUntil (see the handler below), not awaited before
// responding. See lib/legacy/ commit history for the fuller "why waitUntil"
// story — unchanged from v2/v3.
async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const started = Date.now();
  try {
    const d = dedupeKey(sent);
    const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/inbox?on_conflict=key", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal,resolution=merge-duplicates"
      },
      body: JSON.stringify({ key: d.key, sent: d.masked.trim().slice(0, 500) })
    });
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      console.error("supabase inbox insert failed: " + res.status + " " + body.slice(0, 500));
      return String(res.status);
    }
    return "ok";
  } catch (err) {
    console.error("supabase inbox insert threw: " + (err && err.message));
    return "error";
  } finally {
    console.log("t_remember: " + (Date.now() - started) + "ms");
  }
}

// Deletes any stored inbox row for `sent`'s dedupe key. Used for both
// refusal paths — a BLOCK match and the model's own skip — so refused input
// is never retained.
async function forget(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const started = Date.now();
  try {
    const d = dedupeKey(sent);
    const res = await fetch(
      url.replace(/\/+$/, "") + "/rest/v1/inbox?key=eq." + encodeURIComponent(d.key),
      {
        method: "DELETE",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          Prefer: "return=minimal"
        }
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      console.error("supabase inbox delete (refused) failed: " + res.status + " " + body.slice(0, 500));
      return String(res.status);
    }
    return "ok";
  } catch (err) {
    console.error("supabase inbox delete (refused) threw: " + (err && err.message));
    return "error";
  } finally {
    console.log("t_forget: " + (Date.now() - started) + "ms");
  }
}

const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];

module.exports = async function handler(req, res) {
  const stages = newStages();
  stages.t_cold = Date.now() - MODULE_LOADED_AT;

  const origin = req.headers.origin;
  if (origin && ORIGINS.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Keep-warm ping (see vercel.json's cron — every 5 minutes).
  if (req.method === "GET" && req.query && req.query.ping === "1") {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== "Bearer " + secret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) { res.status(429).json({ error: "slow down" }); return; }

  const parseStarted = Date.now();
  const body = readBody(req);
  const sent = String(body.sent || "").trim().slice(0, 500);
  // "make it worse" escalation — only ever sent on a third-tap refetch (see
  // index.html): the visitor has exhausted the three drafts this same
  // `sent` already produced and asked for worse. `shown` is every line
  // already revealed for this result, bounded here the same way `sent`
  // itself is — the one field in this body that's actual free text, not a
  // fixed enum.
  const escalate = body.escalate === true;
  const shown = escalate && Array.isArray(body.shown)
    ? body.shown.map(function (s) { return String(s).slice(0, 300); }).slice(0, 10)
    : [];
  stages.t_parse = Date.now() - parseStarted;
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }

  const blockStarted = Date.now();
  // classifyBlock (lib/block.js) says which of two things a keyword hit
  // means: "crisis" is the pasted text itself describing suicide/self-harm
  // — gets the 988 resource screen, same as a lib/crisis.js semantic hit
  // below — "block" is everything else this list catches (threats,
  // minors, abuse), which gets the plain refusal. Both are logged as a
  // `safety` event by index.html (meta.state/meta.source, source always
  // "keyword" here) — see lib/crisis.js's checkCrisis for the classifier
  // layer's own states, logged the same way further down.
  const blockReason = classifyBlock(sent);
  stages.t_block = Date.now() - blockStarted;
  if (blockReason === "crisis") {
    waitUntil(forget(sent));
    res.status(200).json({ crisis: true, source: "keyword", drafts: [], safety: { state: "crisis", source: "keyword" } });
    return;
  }
  if (blockReason === "block") {
    waitUntil(forget(sent));
    res.status(200).json({ refuse: true, drafts: [], safety: { state: "block", source: "keyword" } });
    return;
  }

  const requestStarted = Date.now();
  const rememberPromise = remember(sent);
  waitUntil(rememberPromise);

  const logged = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) ? "deferred" : null;

  // Curated leads (lib/curated.js) — a tiny hand-picked bank for exactly
  // the four featured example chips (see index.html's #chips). Never
  // consulted on an escalation refetch: those four inputs' curated banks
  // already hold exactly three lines each, so a third "make it worse"
  // tap past them needs a real escalated draft, not the same three lines
  // again.
  if (!escalate) {
    const curated = curatedLeadFor(normalizeBefore(sent));
    if (curated) {
      res.status(200).json({
        sent: sent,
        // Curated lines never touch the judge, so there's no real q/
        // reaction to report — null, same convention the fixed-lane-order
        // fallback below uses. `position` is still real (1-based, bank
        // order) so index.html's escalation logging has something to key
        // on.
        drafts: curated.map(function (d, i) { return { lane: d.lane, text: d.text, q: null, reaction: null, position: i + 1 }; }),
        source: "curated",
        why: "curated",
        provider: null,
        logged: logged,
        debug: null,
        t_gen: null,
        t_judge: null,
        t_total: Date.now() - requestStarted,
        // A curated match never runs the classifier below (or even reaches
        // it) — hand-picked benign text needs neither check, but the
        // client's "safety" event still expects a state/source on every
        // response, so this says so explicitly rather than leaving it out.
        safety: { state: "clear", source: "curated" }
      });
      return;
    }
  }

  // Crisis pre-check (lib/crisis.js) — a second, semantic layer past
  // classifyBlock() above, for ambiguous phrasing ("i don't want to be here
  // anymore") that keyword matching structurally can't catch. Skipped on
  // an escalation refetch — `sent` hasn't changed since the request that
  // already cleared it, and re-running a model classification call on
  // text that hasn't changed just adds latency and cost for the same
  // answer. Resolves to { state, crisis } — see checkCrisis's own comment
  // for what `state` ("clear" | "ambiguous_distress" | "explicit_crisis" |
  // "skipped" | "failed") means; `crisis` is the boolean actually routed on
  // below (true for both explicit_crisis and ambiguous_distress, which
  // currently share the same 988 treatment — see lib/crisis.js's header
  // comment on why they're still logged as separate states regardless).
  // Called here, not awaited here — checkCrisis's own fetch fires the
  // instant this line runs; see the Promise.all further down (right
  // before runGenerationRound is awaited) for where this actually gets
  // raced against generation, so the classifier's ~500ms never lands on
  // top of a multi-second generate-then-judge round instead of overlapping it.
  const crisisPromise = !escalate
    ? checkCrisis(process.env.LLM_API_KEY, sent)
    : Promise.resolve({ state: "skipped", crisis: false });

  const key = process.env.LLM_API_KEY;
  if (!key) {
    const crisisResult = await crisisPromise; // still resolve it so nothing is left dangling, even though there's no model call to gate on it
    res.status(200).json({
      sent: sent,
      drafts: [{ lane: "stall", text: stallLine(), q: null, reaction: null, position: 1 }],
      source: "stall",
      why: "no api key",
      provider: null,
      logged: logged,
      debug: null,
      t_gen: null,
      t_judge: null,
      t_total: Date.now() - requestStarted,
      safety: { state: crisisResult.state, source: "classifier" }
    });
    return;
  }

  const genOpts = { escalate: escalate, shown: shown };

  // One full generate-then-judge pass — the Hermes and GPT-5.4 calls,
  // safety+taste running concurrently on the combined candidate set, then
  // the pairwise final call between the top two by q (see lib/judge.js's
  // judgePairwise). Factored into its own function because regenerate-if-
  // weak (below) can run this exact sequence a second time — never more
  // than once, whatever the second round's own result turns out to be.
  // Every timing lands in a LOCAL object, not the outer `stages` directly,
  // so running this twice doesn't leave `stages` reporting a discarded
  // round's numbers — the caller copies whichever round it actually keeps
  // into `stages` once that's decided.
  async function runGenerationRound() {
    const t = { t_wildcardA: 0, t_wildcardB: 0, t_wildcard: 0, t_primary: 0, t_judge: 0, t_pairwise: 0 };

    // Each call's own slot, plus whether it's settled yet — the soft
    // deadline below needs to inspect exactly which calls are already
    // done at the 4500ms mark, not just "some subset finished." The
    // promise itself is untouched either way: a call past the deadline
    // isn't cancelled, it just isn't awaited for this response — see the
    // soft-deadline branch below for what happens to it instead. Three
    // slots now, not two — wildcardA/wildcardB are the two halves of the
    // Hermes room (see this file's own header comment for why one big
    // call became two smaller parallel ones).
    const slots = {
      wildcardA: { settled: false, result: null },
      wildcardB: { settled: false, result: null },
      primary: { settled: false, result: null }
    };
    const wildcardAStarted = Date.now();
    const wildcardAPromise = runGenerator(key, WILDCARD_MODEL, sent, "wildcard", Object.assign({ lanes: WILDCARD_LANE_PLAN_A }, genOpts))
      .then(function (r) { t.t_wildcardA = Date.now() - wildcardAStarted; slots.wildcardA.settled = true; slots.wildcardA.result = r; return r; });
    const wildcardBStarted = Date.now();
    const wildcardBPromise = runGenerator(key, WILDCARD_MODEL, sent, "wildcard", Object.assign({ lanes: WILDCARD_LANE_PLAN_B }, genOpts))
      .then(function (r) { t.t_wildcardB = Date.now() - wildcardBStarted; slots.wildcardB.settled = true; slots.wildcardB.result = r; return r; });
    // GENERATOR_MODEL only ever runs on an escalation refetch now — the
    // first-show room is entirely Hermes (see this file's own header
    // comment and lib/prompt.js's). A first-show request never pays for or
    // waits on this call at all: it resolves immediately with zero
    // candidates, same shape a real call's result would have, so nothing
    // downstream (soft deadline, safety/taste, `why`) needs to know the
    // difference.
    const primaryStarted = Date.now();
    const primaryPromise = (escalate
      ? runGenerator(key, GENERATOR_MODEL, sent, "primary", Object.assign({ lanes: primaryLanePlan(genOpts) }, genOpts))
      : Promise.resolve({ lines: [], why: "skipped — first-show room is Hermes only (shock/raunchy/deranged/gross), confession/dark/absurd are escalation-only", provider: null, premises: null }))
      .then(function (r) { t.t_primary = Date.now() - primaryStarted; slots.primary.settled = true; slots.primary.result = r; return r; });
    const allPromises = { wildcardA: wildcardAPromise, wildcardB: wildcardBPromise, primary: primaryPromise };

    // Soft deadline: wait up to GENERATION_SOFT_DEADLINE_MS for all three
    // calls. If all are done by then (the common case — this is a race
    // against a timer, not a fixed delay, and splitting Hermes into two
    // smaller calls makes this the common case far more often than the
    // old single six-candidate call did), this behaves exactly like the
    // plain Promise.all it replaces. If the deadline wins instead, check
    // what's actually in hand: MIN_CANDIDATES_FOR_SOFT_DEADLINE or more
    // real candidates already resolved is enough to start judging now
    // rather than wait on a slow straggler — fewer than that, and the
    // soft deadline can't help (proceeding with too little just means a
    // thinner result), so it falls back to waiting for everything, same
    // as before this feature existed.
    //
    // GENERATION_SOFT_DEADLINE_MS lowered from 4500 to 3500 in a later
    // latency pass — this is a race against a timer, not a fixed cost, so
    // a lower deadline only ever means "give up on a slow straggler
    // sooner," never "wait less when everything's already fast."
    //
    // MIN_CANDIDATES_FOR_SOFT_DEADLINE tracks whatever one Hermes half's
    // own count is (WILDCARD_LANE_PLAN_A/_B's length) — a first-show
    // request's primary is always the zero-candidate stub, so the
    // threshold has to be clearable by ONE half landing alone, or it's
    // not really a soft deadline firing, just Promise.all resolving early
    // once BOTH halves happen to finish. Was 4 when each half wrote four
    // candidates; now 3, matching each half's own three.
    const GENERATION_SOFT_DEADLINE_MS = 3500;
    const MIN_CANDIDATES_FOR_SOFT_DEADLINE = 3;
    let lateGroupCount = 0;
    // Kept in scope past the soft-deadline dance below (not just inside
    // the branch that sets it) — the stall-rescue path further down
    // (right before this function returns) needs to know whether there's
    // still a call in flight worth waiting a little longer for, on the
    // rare request where everything else got eliminated.
    let pendingPromisesInFlight = [];
    await Promise.race([Promise.all([wildcardAPromise, wildcardBPromise, primaryPromise]), sleep(GENERATION_SOFT_DEADLINE_MS)]);

    const pendingKeys = Object.keys(slots).filter(function (k) { return !slots[k].settled; });
    let wildcardA, wildcardB, primaryResult;
    if (!pendingKeys.length) {
      wildcardA = slots.wildcardA.result;
      wildcardB = slots.wildcardB.result;
      primaryResult = slots.primary.result;
    } else {
      const inHandCount = Object.keys(slots).reduce(function (sum, k) { return sum + (slots[k].settled ? (slots[k].result.lines || []).length : 0); }, 0);
      if (inHandCount >= MIN_CANDIDATES_FOR_SOFT_DEADLINE) {
        lateGroupCount = pendingKeys.length;
        const pendingFallback = { lines: [], why: "pending past " + GENERATION_SOFT_DEADLINE_MS + "ms soft deadline", provider: null, premises: null };
        wildcardA = slots.wildcardA.settled ? slots.wildcardA.result : pendingFallback;
        wildcardB = slots.wildcardB.settled ? slots.wildcardB.result : pendingFallback;
        primaryResult = slots.primary.settled ? slots.primary.result : pendingFallback;
        // The pending call(s) are already running — nothing to cancel,
        // nothing more to await here. waitUntil just keeps the function
        // alive long enough for them to actually finish (rather than the
        // runtime tearing down the instant this response goes out)
        // purely so cacheStragglers below has something to write; a
        // failure here is swallowed on purpose — a lost straggler just
        // means the next escalation request generates fresh, same as it
        // always has. The SAME promises are also raced against a short
        // rescue window further down if this round ends up with nothing
        // to show — see pendingPromisesInFlight above and the
        // stall-rescue block right before this function returns.
        pendingPromisesInFlight = pendingKeys.map(function (k) { return allPromises[k]; });
        waitUntil(
          Promise.all(pendingPromisesInFlight)
            .then(function (results) {
              const stragglerCandidates = results.reduce(function (acc, r) { return acc.concat(r.lines || []); }, []);
              if (stragglerCandidates.length) {
                console.log("stragglers landed: " + stragglerCandidates.length + " candidate(s) past soft deadline, cached for escalation");
                cacheStragglers(sent, stragglerCandidates);
              }
            })
            .catch(function () {})
        );
      } else {
        const all = await Promise.all([wildcardAPromise, wildcardBPromise, primaryPromise]);
        wildcardA = all[0];
        wildcardB = all[1];
        primaryResult = all[2];
      }
    }

    // Merges the two Hermes sub-calls back into the single `wildcard`
    // shape every downstream consumer already expects (lines/why/
    // provider/premises/debugLines/t_gen/skip) — nothing past this point
    // in the function, or in the outer handler, needs to know there were
    // two calls instead of one. `skip` is true if EITHER half refused,
    // same "either refusal is a full refusal" reasoning the wildcard/
    // primary check just below already applies.
    const wildcard = {
      skip: !!(wildcardA.skip || wildcardB.skip),
      lines: (wildcardA.lines || []).concat(wildcardB.lines || []),
      why: "A: " + (wildcardA.skip ? "skipped" : (wildcardA.why || "?")) + " · B: " + (wildcardB.skip ? "skipped" : (wildcardB.why || "?")),
      provider: wildcardA.provider || wildcardB.provider || null,
      debugLines: (wildcardA.debugLines || []).concat(wildcardB.debugLines || []),
      t_gen: Math.max(wildcardA.t_gen || 0, wildcardB.t_gen || 0) || null,
      premises: wildcardA.premises || wildcardB.premises || null
    };
    t.t_wildcard = Math.max(t.t_wildcardA || 0, t.t_wildcardB || 0);

    // Either generator declining outright is a full refusal. v3 only gave
    // this treatment to the (several) primary calls, since a lone
    // wildcard refusal was two lanes' worth of "no" next to eight lanes
    // of real output — that asymmetry doesn't hold in v4: wildcard/Hermes
    // is now the bulk call (seven of nine-or-ten candidates), and both
    // prompts share the exact same "abusive, sexual toward a minor, or a
    // threat" skip instruction, so a refusal from either side carries the
    // same signal.
    if (wildcard.skip || primaryResult.skip) {
      return { refuse: true, wildcard: wildcard, primaryResult: primaryResult, t: t };
    }

    // On an escalation request specifically, pick up any stragglers an
    // earlier (non-escalation) request for this same text left running
    // past its own soft deadline — see cacheStragglers/takeStragglers
    // above. A no-op (empty array) whenever there's nothing cached, which
    // is the ordinary case — most escalation requests won't have a
    // straggler waiting for them.
    const stragglers = escalate ? takeStragglers(sent) : [];
    const freshCandidates = (wildcard.lines || []).concat(primaryResult.lines || []);
    // Judged pool cap — relevant on an escalation refetch specifically;
    // first-show's own fresh candidates never get close to this on their
    // own (six candidates from Hermes, primary stubbed to zero — see this
    // file's own header comment). On escalation, primary contributes up
    // to three more and a large straggler cache could otherwise pile on
    // top of a full fresh batch, taking safety+taste's own latency well
    // past what a "make it worse" tap should cost. Stragglers only
    // BACKFILL — they fill the gap when this round's own fresh generation
    // came back short of the cap, never just get appended on top of a
    // full one.
    const JUDGED_POOL_CAP = 8;
    const backfillRoom = Math.max(0, JUDGED_POOL_CAP - freshCandidates.length);
    const stragglersUsed = stragglers.slice(0, backfillRoom);
    const allCandidates = freshCandidates.concat(stragglersUsed).slice(0, JUDGED_POOL_CAP);

    // Judges one candidate list — SAFETY and TASTE running CONCURRENTLY,
    // not safety-then-taste gating what taste even sees (taste judges
    // every candidate in parallel with safety judging every candidate,
    // and only once both are back does a safety flag remove a candidate
    // from the ranking), then the pairwise final between the top two by
    // q. Factored out of what used to be this function's own inline body
    // so the stall-rescue path below (a straggler landing just after
    // everything else got eliminated) can re-run this exact judging on a
    // second, smaller candidate list without duplicating it — the
    // ordinary path just below calls this exactly once, same behavior as
    // before this existed.
    //
    // lib/judge.js's judgeOneLine (safety, cheap model, one call per
    // candidate) and judgeCandidates (taste, expensive model, split into
    // two parallel batches — see lib/judge.js's own comments for both).
    async function judgeAndRank(candidates) {
      const judgeStarted = Date.now();
      const [safetyVerdicts, taste] = await Promise.all([
        candidates.length
          ? Promise.all(candidates.map(function (item) { return judgeOneLine(key, composeDraft(sent, item.text)); }))
          : Promise.resolve([]),
        candidates.length
          ? judgeCandidates(key, sent, candidates)
          : Promise.resolve({ ok: false, reason: "no candidates" })
      ]);
      const tJudge = Date.now() - judgeStarted;

      const safetyModelsSeen = [];
      // Safety calls all fire together (one Promise.all, see above), so
      // the group's real wall-clock cost is the SLOWEST one, not their
      // sum — safetyLatencyTotal used to be reported as if it were the
      // group's cost, which overstated it by roughly 10x at ten
      // candidates. Both are tracked now: safetyMaxLatency is what
      // actually gates the response, safetyLatencyTotal rides along too
      // since the sum is still useful for seeing total model-side cost
      // even though it's not wall time.
      let safetyLatencyTotal = 0;
      let safetyMaxLatency = 0;
      let droppedSafetyCount = 0;
      let safetyFailedCount = 0;
      let safetyRateLimitedCount = 0;
      const safetyReasons = [];
      // Candidates safety flagged — checked by identity (the exact
      // objects in `candidates`, which is also what taste.ranked/
      // taste.details.candidate reference) against both the ranking and
      // the fallback ordering below, regardless of what taste made of
      // the same candidate.
      const flagged = new Set();
      candidates.forEach(function (item, i) {
        const result = safetyVerdicts[i];
        safetyLatencyTotal += result.latencyMs || 0;
        if (result.latencyMs != null && result.latencyMs > safetyMaxLatency) safetyMaxLatency = result.latencyMs;
        if (result.model && safetyModelsSeen.indexOf(result.model) === -1) safetyModelsSeen.push(result.model);
        if (result.verdict === null) safetyFailedCount++;
        // Every call's own latency, always — not just failures — so a
        // slow stretch (queueing, an upstream having a bad day) is
        // visible in the logs without a failure to trigger it.
        console.log("safety [" + (item.lane || "?") + "] latencyMs=" + (result.latencyMs != null ? result.latencyMs : "?"));
        // result.reason is set the moment SAFETY_MODEL's own first
        // attempt failed, even if a fallback then rescued the verdict
        // (see judgeOneLine's own comment) — logged in full here (Vercel
        // function logs), and a capped sample rides in `why` below so
        // ?debug=1 shows it too, without one bad run making `why`
        // enormous. A 429 specifically (real rate limiting, distinct
        // from a timeout) is counted separately so it's visible at a
        // glance whether that's ever actually happening.
        if (result.reason) {
          console.error("safety judge fallback/failure [" + (item.lane || "?") + "]: " + result.reason);
          safetyReasons.push("[" + item.lane + "] " + result.reason);
          if (/\bhttp 429\b/.test(result.reason)) safetyRateLimitedCount++;
        }
        if (result.verdict === true) { droppedSafetyCount++; flagged.add(item); }
      });
      const safetyNote = "safety: " + droppedSafetyCount + " dropped" +
        (safetyFailedCount ? " (" + safetyFailedCount + " failed open)" : "") +
        (safetyRateLimitedCount ? " (" + safetyRateLimitedCount + " rate-limited)" : "") +
        (safetyModelsSeen.length
          ? " · safety model: " + safetyModelsSeen.join("+") + " (wall " + safetyMaxLatency + "ms, sum " + safetyLatencyTotal + "ms across " + candidates.length + " calls)"
          : "") +
        (safetyReasons.length ? " · " + safetyReasons.slice(0, 3).join(" | ") + (safetyReasons.length > 3 ? " (+" + (safetyReasons.length - 3) + " more, see logs)" : "") : "");

      // Escalation is intensity, not a plain rank order. Position 1 is
      // still the highest-q candidate — unchanged throughout every
      // revision of this rule. Positions 2 and 3's own rule has moved
      // twice past the original v4 shape (reaction strictly greater than
      // the position before it, chained): the raunchy/gross-only room ran
      // everything near max intensity, so "strictly more" almost never
      // had anywhere left to climb (see lib/prompt.js's own header for
      // that room and its later lane-mix revision); the fix at the time
      // loosened this to "within 2 of position 1, either direction" —
      // which then let a "take it further" tap reveal something LESS
      // intense than what was already shown, reading as a reroll rather
      // than an escalation. Current rule (in the outer handler's own
      // position-selection loop, not here): chained again, position 2
      // against position 1 and position 3 against position 2, but not
      // required to be STRICTLY greater anymore — `next.reaction >=
      // prev.reaction` — see that loop's own comment for why. `reaction`
      // replaces v3's `shock` here — see lib/judge.js's header comment
      // for why: it's the same intensity axis, renamed to match what the
      // score actually measures now that it's a real judged criterion
      // instead of a value deliberately held out of q.
      let survivors, tasteNote;
      if (taste.ok) {
        survivors = taste.ranked.filter(function (r) { return !flagged.has(r.candidate); });
        // Every candidate's q/reaction, and the gate that killed each
        // eliminated one — exactly what ?debug=1 needs to see the
        // judge's actual reasoning, not just its final picks. A safety-
        // flagged candidate is tagged here too, whatever taste made of
        // it, since that's exactly why it's missing from `survivors`
        // above.
        const totalsNote = taste.details.map(function (d) {
          const flag = flagged.has(d.candidate) ? " [safety-flagged]" : "";
          return "[" + d.lane + "] " + (d.eliminated ? "elim:" + d.killedBy : "q:" + d.q + " reaction:" + d.reaction) + flag;
        }).join(", ");
        tasteNote = "taste: " + taste.model + " (" + (taste.latencyMs || 0) + "ms) — " + totalsNote;
      } else {
        // Fallback: fixed lane order — still a reasonable "something is
        // better than nothing" ordering, just not the ranked-by-taste/
        // intensity one. There's no real q/reaction to gate escalation
        // on here, so every position below just takes the next lane-
        // ordered survivor.
        survivors = candidates
          .filter(function (item) { return !flagged.has(item); })
          .sort(function (a, b) { return ALL_LANES.indexOf(a.lane) - ALL_LANES.indexOf(b.lane); })
          .map(function (item) { return { candidate: item, q: null, reaction: null }; });
        tasteNote = "taste: failed open (" + taste.reason + ") — fell back to fixed lane order";
      }

      // Pairwise final: after gates and scoring, the top two by q get
      // one head-to-head call — "which would make a stranger put the
      // phone down and go show someone" — and the winner becomes
      // position 1. Only meaningful when taste actually produced real q
      // scores to pick a "top two" from; the fixed-lane-order fallback
      // above has nothing worth comparing on. Swaps `survivors[0]`/
      // `survivors[1]` in place when 2 wins — the position-selection
      // loop in the outer handler stays exactly as it was, just starting
      // from whichever candidate the pairwise call preferred. A failed
      // or unparsable pairwise call just keeps taste's own order, same
      // "degrade, don't block" pattern the taste judge itself follows.
      let pairwiseNote = "";
      let tPairwise = 0;
      if (taste.ok && survivors.length >= 2) {
        const pairwiseStarted = Date.now();
        const pw = await judgePairwise(key, sent, survivors[0].candidate, survivors[1].candidate);
        tPairwise = Date.now() - pairwiseStarted;
        if (pw.winner === 2) {
          const tmp = survivors[0];
          survivors[0] = survivors[1];
          survivors[1] = tmp;
          pairwiseNote = "pairwise: swapped, 2 won (" + pw.latencyMs + "ms)";
        } else if (pw.winner === 1) {
          pairwiseNote = "pairwise: kept, 1 won (" + pw.latencyMs + "ms)";
        } else {
          pairwiseNote = "pairwise: no verdict (" + pw.reason + "), kept taste's order";
        }
      }

      return { taste: taste, survivors: survivors, safetyNote: safetyNote, tasteNote: tasteNote, pairwiseNote: pairwiseNote, tJudge: tJudge, tPairwise: tPairwise };
    }

    let judged = await judgeAndRank(allCandidates);
    t.t_judge += judged.tJudge;
    t.t_pairwise += judged.tPairwise;
    let stragglerPickupCount = stragglersUsed.length;

    // Stall rescue: if every candidate in this round's own pool got
    // eliminated or safety-flagged (survivors empty) and there's still a
    // call in flight from the soft-deadline branch above
    // (pendingPromisesInFlight), don't default to a stall immediately —
    // give it up to STALL_RESCUE_DEADLINE_MS more. A straggler landing a
    // second or two late is a real candidate pool, not a reason to show
    // nothing when one might be seconds away. Only relevant when the
    // soft deadline actually fired earlier in this same round — the
    // ordinary path (everything settled before the soft deadline) has
    // nothing pending here and skips this entirely, same cost as before
    // this existed.
    //
    // Known gap: a successful rescue swaps in the rescued survivors but
    // doesn't retroactively update `wildcard`/`primaryResult` (still
    // whichever placeholder they got at the soft deadline) — the actual
    // response ships the rescued draft correctly, `?debug=1`'s per-
    // generator panel just won't show where it came from. Not worth the
    // extra bookkeeping for a rescue that, by definition, only fires when
    // the ordinary path already came back with nothing to show.
    let stallRescueNote = "";
    if (!judged.survivors.length && pendingPromisesInFlight.length) {
      const STALL_RESCUE_DEADLINE_MS = 2000;
      const rescueStarted = Date.now();
      const rescue = await Promise.race([
        Promise.all(pendingPromisesInFlight).then(function (results) { return { landed: true, results: results }; }),
        sleep(STALL_RESCUE_DEADLINE_MS).then(function () { return { landed: false, results: [] }; })
      ]);
      const rescueWaitMs = Date.now() - rescueStarted;
      if (!rescue.landed) {
        stallRescueNote = "stall rescue: still pending after " + STALL_RESCUE_DEADLINE_MS + "ms — stalling";
      } else {
        const rescueCandidates = rescue.results.reduce(function (acc, r) { return acc.concat(r.lines || []); }, []);
        if (!rescueCandidates.length) {
          stallRescueNote = "stall rescue: pending call(s) landed after " + rescueWaitMs + "ms with nothing usable — stalling";
        } else {
          const rescued = await judgeAndRank(rescueCandidates);
          t.t_judge += rescued.tJudge;
          t.t_pairwise += rescued.tPairwise;
          if (rescued.survivors.length) {
            judged = rescued;
            stragglerPickupCount += rescueCandidates.length;
            stallRescueNote = "stall rescue: " + rescueCandidates.length + " straggler(s) landed after " + rescueWaitMs + "ms, " + rescued.survivors.length + " survived — used instead of stalling";
          } else {
            stallRescueNote = "stall rescue: " + rescueCandidates.length + " straggler(s) landed after " + rescueWaitMs + "ms, none survived — stalling";
          }
        }
      }
      console.log(stallRescueNote);
    }

    return {
      refuse: false, wildcard: wildcard, primaryResult: primaryResult, taste: judged.taste,
      safetyNote: judged.safetyNote, tasteNote: judged.tasteNote, pairwiseNote: judged.pairwiseNote,
      survivors: judged.survivors, t: t, lateGroupCount: lateGroupCount, stragglerPickupCount: stragglerPickupCount,
      stallRescueNote: stallRescueNote
    };
  }

  // crisisPromise (built above, right after the curated-lead check) has
  // been in flight since before this line — checkCrisis() starts its own
  // fetch the instant it's called, not when awaited — but the two awaits
  // used to be sequential here (`await runGenerationRound()` THEN `await
  // crisisPromise`), which reads as "crisis check happens after
  // generation" even though the underlying requests were already
  // overlapping. Promise.all makes that explicit and unambiguous instead
  // of relying on incidental ordering that a future edit could silently
  // break by adding an await in between: crisisResult adds essentially no
  // wall-clock here either way, since the classifier call is far shorter
  // than a full generate-then-judge round.
  let [round, crisisResult] = await Promise.all([runGenerationRound(), crisisPromise]);

  if (crisisResult.crisis) {
    waitUntil(rememberPromise.then(function () { return forget(sent); }));
    res.status(200).json({ crisis: true, source: "model", drafts: [], safety: { state: crisisResult.state, source: "classifier" } });
    return;
  }

  if (round.refuse) {
    waitUntil(rememberPromise.then(function () { return forget(sent); }));
    res.status(200).json({ refuse: true, drafts: [], safety: { state: crisisResult.state, source: "classifier" } });
    return;
  }

  // Regenerate-if-weak, v4: two separate triggers, either one is enough to
  // spend one extra round. v3 only had the q-based one (REGEN_THRESHOLD,
  // re-tuned here for v4's new q range — see this file's own comment on
  // the constant); the addendum (section F) adds a hard floor on top:
  // position 1 must score reaction >= REACTION_LEAD_GATE, since a
  // technically-decent q with no actual reaction is exactly the BORED
  // failure mode lib/judge.js's calibration block is built to name. Capped
  // at exactly one extra round no matter how the second round itself
  // scores — this is a retry, not a search for perfect. A second round
  // that comes back an outright refusal just keeps the first round's
  // (already-known-good) result rather than failing a request that had
  // already succeeded once.
  //
  // REGEN_THRESHOLD's default changed from v3's 30 — that was calibrated
  // against a formula whose max was roughly 80; v4's formula
  // (2*reaction + specificity - interchangeable) maxes out at 30, so a
  // literal 30 threshold would now mean "regenerate unless it's perfect,"
  // never actually clearing. 11 is a provisional rescale (roughly the same
  // fraction of the new max v3's 30 was of the old one) — the v4 brief
  // (section 6) calls for running the full corpus once real traffic exists
  // and setting this at the 30th percentile of real top scores instead;
  // that's an operational step this commit can't responsibly fake a number
  // for without actually running it.
  const REGEN_THRESHOLD = Number(process.env.REGEN_THRESHOLD) || 11;
  const REACTION_LEAD_GATE = 6;
  function bestQOf(r) { return r.survivors.length && r.survivors[0].q != null ? r.survivors[0].q : null; }
  function bestReactionOf(r) { return r.survivors.length && r.survivors[0].reaction != null ? r.survivors[0].reaction : null; }

  let regenerated = false;
  const firstRoundBestQ = bestQOf(round);
  const firstRoundBestReaction = bestReactionOf(round);
  const needsRegen = (firstRoundBestQ != null && firstRoundBestQ < REGEN_THRESHOLD) ||
    (firstRoundBestReaction != null && firstRoundBestReaction < REACTION_LEAD_GATE);
  if (needsRegen) {
    const regenRound = await runGenerationRound();
    if (!regenRound.refuse) {
      round = regenRound;
      regenerated = true;
    }
  }

  // weak_lead: even after a regen attempt, position 1 may still be under
  // REACTION_LEAD_GATE — ships anyway (failing this request a second time
  // isn't better for anyone), but logged explicitly rather than silently,
  // per the addendum's own instruction ("never ship silently").
  const finalBestReaction = bestReactionOf(round);
  const weakLead = finalBestReaction != null && finalBestReaction < REACTION_LEAD_GATE;

  stages.t_wildcardA = round.t.t_wildcardA;
  stages.t_wildcardB = round.t.t_wildcardB;
  stages.t_wildcard = round.t.t_wildcard;
  stages.t_primary = round.t.t_primary;
  stages.t_judge = round.t.t_judge;
  stages.t_pairwise = round.t.t_pairwise;
  const wildcard = round.wildcard;
  const primaryResult = round.primaryResult;
  const taste = round.taste;
  const safetyNote = round.safetyNote;
  const tasteNote = round.tasteNote;
  const pairwiseNote = round.pairwiseNote;
  const survivors = round.survivors;
  const lateGroupCount = round.lateGroupCount;
  const stragglerPickupCount = round.stragglerPickupCount;
  const stallRescueNote = round.stallRescueNote;

  // Position selection also enforces per-response diversity now (see
  // lib/postprocess.js's createDiversityTracker) — a repeated opening
  // move, background prop, or simile across positions 1-3 reads as one
  // joke shown three times, not three different ones. v3 exported this
  // tracker with a comment saying it was "driven from callOnce" but never
  // actually wired it into this loop — every response before this line
  // skipped diversity dedup entirely (the v4 addendum's section G asked
  // specifically whether every generation path runs the full postprocess
  // pipeline; this was the one real gap found, not bible-prep.js or the
  // word cap/crutch filters, which were already applied everywhere).
  const diversityTracker = createDiversityTracker();
  // "Escalation must escalate" fix: the previous rule (within
  // REACTION_CLOSE_ENOUGH=2 of position 1's own reaction, either
  // direction) let a "take it further" tap reveal something LESS intense
  // than what was already shown, which reads as a reroll, not an
  // escalation. Positions 2 and 3 now have to be at least as intense as
  // the position right before them — chained again, like the original
  // pre-v5 rule, not anchored to position 1 the way the last fix had it.
  //
  // Written here as `s.reaction >= prev.reaction`, which is the actual
  // requirement — the task that asked for this fix stated it as two
  // conditions, "shock >= shock(prev) AND reaction >= reaction(prev) -
  // 2"; `shock` is this codebase's own retired name for the same
  // `reaction` field (see lib/judge.js's own header on why v4 folded
  // shock into reaction), so both conditions are on the same scale, and
  // the first (>=) already implies the second (>= -2) — there's nothing
  // the second half of that AND would ever additionally exclude. Kept as
  // one condition rather than two redundant ones; flag if a genuinely
  // separate second metric was actually intended.
  //
  // No q-based tolerance gate anymore either (the pre-v5 rule's `s.q >=
  // 0.7 * prev.q`) — the new rule is stated purely in terms of
  // reaction/shock, so a candidate that clears the reaction bar is
  // eligible regardless of how its q compares; q still decides which one
  // among the eligible candidates gets picked (`remaining` stays
  // q-descending).
  let raunchyUsed = false;
  // Mechanical backstop for the lane-mix restore's RAUNCHY_INVITATION_RULE
  // (lib/prompt.js) — at most one proposition-shaped (lane:raunchy) line
  // across the whole pool a visitor sees, whatever the model made of the
  // prompt's own gating. A candidate is only ever tagged raunchy when the
  // model actually wrote a real proposition (a dry text is told to write
  // shock/deranged/gross in that slot instead — see that file's own rule),
  // so "at most one raunchy position" and "at most one proposition-shaped
  // line" are the same rule here, not two separate checks.
  const positions = [];
  if (survivors.length) {
    positions.push(survivors[0]);
    diversityTracker.record(survivors[0].candidate.text);
    if (survivors[0].candidate.lane === "raunchy") raunchyUsed = true;
  }
  for (let need = 2; need <= 3 && positions.length === need - 1; need++) {
    const prev = positions[need - 2];
    const remaining = survivors.slice(1).filter(function (s) {
      return positions.indexOf(s) === -1 && !(raunchyUsed && s.candidate.lane === "raunchy");
    });
    // remaining is still q-descending (inherited from `survivors`'
    // own order), so the first one clearing the reaction bar is the
    // highest-q qualifier — no separate re-sort needed.
    const next = prev.reaction == null
      ? remaining.filter(function (s) { return !diversityTracker.isDuplicate(s.candidate.text); })[0]
      : remaining.filter(function (s) { return s.reaction >= prev.reaction && !diversityTracker.isDuplicate(s.candidate.text); })[0];
    if (!next) break;
    positions.push(next);
    diversityTracker.record(next.candidate.text);
    if (next.candidate.lane === "raunchy") raunchyUsed = true;
  }

  const responseStarted = Date.now();
  const drafts = positions.map(function (p, i) {
    return { lane: p.candidate.lane, text: p.candidate.text, q: p.q, reaction: p.reaction, position: i + 1 };
  });
  const source = drafts.length ? "model" : "stall";
  if (!drafts.length) drafts.push({ lane: "stall", text: stallLine(), q: null, reaction: null, position: 1 });

  stages.t_response = Date.now() - responseStarted;
  const why = "wildcard: " + (wildcard.skip ? "skipped" : (wildcard.why || "?")) +
    " · primary: " + (primaryResult.skip ? "skipped" : (primaryResult.why || "?")) +
    " · " + safetyNote + " · " + tasteNote +
    (pairwiseNote ? " · " + pairwiseNote : "") +
    (regenerated ? " · regen: true (first round best q " + firstRoundBestQ + ", best reaction " + firstRoundBestReaction + ")" : "") +
    (weakLead ? " · weak_lead: true (best reaction " + finalBestReaction + " < " + REACTION_LEAD_GATE + ")" : "") +
    (lateGroupCount ? " · late: " + lateGroupCount + " (proceeded past soft deadline, call(s) finishing in background)" : "") +
    (stragglerPickupCount ? " · stragglers picked up: " + stragglerPickupCount : "") +
    (stallRescueNote ? " · " + stallRescueNote : "") +
    " · stages: " + formatStages(stages);

  const genTGen = Math.max(wildcard.t_gen || 0, primaryResult.t_gen || 0) || null;
  const genProvider = primaryResult.provider || wildcard.provider || null;
  // Two entries — one per generator call — each carrying whichever three
  // premises that call worked out about the sent text before writing its
  // own lanes (see lib/prompt.js's buildWildcardPrompt/buildPrimaryPrompt).
  // Never returned to the client's own display, only into `debug` for
  // ?debug=1 to read. A call that never got that far (parse failure,
  // refusal, timeout) just carries null premises here, same as
  // debugLines does for its own "nothing to show" case.
  const premises = { wildcard: wildcard.premises || null, primary: primaryResult.premises || null };

  const t_total = Date.now() - requestStarted;
  // Escalation latency specifically — this whole round of changes exists
  // because "make it worse" taps were slow, so this is the number that
  // actually says whether they still are, without having to go dig
  // t_total back out of a client-side network log. First-show requests
  // don't get this same console.log: their latency is already visible in
  // `why`'s own `stages` breakdown above, logged on every response either
  // way.
  if (escalate) {
    console.log("escalation t_total=" + t_total + "ms (fetch this text has asked for since the original request)");
  }

  res.status(200).json({
    sent: sent,
    drafts: drafts,
    source: source,
    why: why || null,
    provider: genProvider,
    logged: logged,
    weak_lead: weakLead,
    debug: {
      primary: primaryResult.debugLines || null,
      wildcard: wildcard.debugLines || null,
      judge: taste.ok ? taste.details : null,
      premises: premises
    },
    t_gen: genTGen,
    t_judge: stages.t_judge,
    t_total: t_total,
    safety: { state: crisisResult.state, source: "classifier" }
  });
};

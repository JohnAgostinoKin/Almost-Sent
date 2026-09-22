// api/draft.js — v6: one model, one room, three lanes, everywhere.
//
// v5 fired Hermes (WILDCARD_MODEL) as two parallel calls on every
// request, and GENERATOR_MODEL (GPT-5.4) as a third concurrent call on an
// escalation refetch only, writing confession/dark/absurd. v6 retires
// GENERATOR_MODEL and every lane it only ever wrote — see lib/prompt.js's
// own header — so Hermes is the entire engine now, first tap through
// escalation alike: runGenerationRound below fires exactly the same two
// parallel calls (wildcardA/wildcardB) every time, `escalate` and `shown`
// riding through genOpts into both regardless of which tap this is. There
// is no third call, and no more skip-when-not-escalating stub to reason
// about.
//
// One call, though, meant one BIG call — writing every candidate in a
// single request left nothing partial for the soft deadline (below) to
// fall back to; it was one slow call or nothing. runGenerationRound fires
// Hermes as TWO parallel calls instead (wildcardA/wildcardB, see lib/
// prompt.js's lanePlansFor — the same three lanes in each now,
// not a split lane set), each faster than one big call would be, merged
// back into a single `wildcard` result before safety/taste ever sees it.
//
// A later latency pass shrank Hermes' own per-call count (three
// candidates a call, not four — lib/prompt.js's own header has the
// current split), lowered GENERATION_SOFT_DEADLINE_MS to 3500ms, dropped
// premise-first from the wildcard prompt (built for GPT, costing Hermes a
// real second per call for output nothing downstream ever showed — see
// lib/prompt.js's own header), dropped the pairwise final call entirely
// (position 1 is just the top-q survivor now — see judgeAndRank below),
// and capped the judged candidate pool at JUDGED_POOL_CAP on an
// escalation refetch specifically — a large straggler cache could
// otherwise stack on top of a full fresh Hermes batch, taking safety+
// taste well past what a "make it worse" tap should cost. Stragglers only
// backfill the gap now (fresh generation short of the cap), never pile on
// top of a full batch — see runGenerationRound's own comment on
// JUDGED_POOL_CAP for the exact rule. That same pass adds a full-result
// cache, keyed by normalized input, alongside the straggler cache's own
// store — see cacheResult/getCachedResult below — so a repeated
// first-show input skips generation and judging entirely for 24 hours
// instead of paying for it again.
//
// t_cold (module-load-to-request gap — see MODULE_LOADED_AT below) is now
// console.log'd unconditionally, before any branch, and carried on every
// JSON response that already had a t_total — the "is a cold paste really
// still 11s" question needs this visible in both Vercel's own function
// logs and the Supabase funnel (index.html forwards it into draft_shown's
// meta; see scripts/funnel.sql's own t_cold query) to actually answer,
// not just asserted from a single manual run.
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
// on a second expensive call. Position 1 is simply the highest-q
// survivor — the pairwise final (one more head-to-head call between the
// top two by q) is gone; see judgeAndRank's own comment.
//
// v4 adds one more hard gate past taste's own five (see the v4 addendum,
// section F): position 1 must score reaction >= REACTION_LEAD_GATE. A
// weak first round triggers the same one-extra-round regenerate-if-weak
// v3 already had — reaction alone now (the old q-based REGEN_THRESHOLD
// is gone; see needsRegen's own comment for why); if the second round
// STILL doesn't clear the reaction gate, this ships the best available
// anyway rather than failing a request that already succeeded once —
// but logs weak_lead:true rather than shipping silently, per the
// addendum's own instruction. Never on an escalation refetch, though —
// see needsRegen's own comment for the real production hang (45s, no
// client-side timeout to ever give up on it) that fix traces back to.

const { norm } = require("../lib/normalize");
const { callLLM } = require("../lib/llm");
const { WILDCARD_MODEL, lanePlansFor, ALL_LANES, normalizeBefore } = require("../lib/prompt");
const {
  extractPremiseCandidates, normalizeItem, isRefusal, filterLines, describeDrops, createDiversityTracker
} = require("../lib/postprocess");
const { judgeOneLine, judgeCandidates, demoteUnjudged, judgePairwise } = require("../lib/judge");
const { composeDraft } = require("../lib/compose");
const { stallLine } = require("../lib/fallback");
const { classifyBlock } = require("../lib/block");
const { checkCrisis } = require("../lib/crisis");
const { curatedLeadFor } = require("../lib/curated");
const { createLimiter } = require("../lib/rateLimit");
const { maskPII } = require("../lib/mask");
const { getPrecomputed } = require("../lib/precomputed");
const { waitUntil: waitUntilImpl } = require("@vercel/functions");

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

// Full-result cache — the same Map as the stragglers above (this is
// deliberately "the straggler cache's store," not a second Map), just a
// different key shape so the two never collide: a straggler entry's key
// is bare normalizeBefore(sent), a result entry's is that prefixed with
// "result2:". A repeated first-show input (the common case for a shared
// chip or a viral screenshot) skips generation and judging entirely for
// RESULT_CACHE_TTL_MS — same warm-container-only caveat as every other
// cache in this file: a cold start just means the next request for that
// text generates fresh, same as it always has. Escalation is deliberately
// NOT cached here — `shown` and the escalation state change every tap for
// the same `sent`, so there's no single "the" result for that key to
// reuse.
//
// "result2:" (not "result:") is deliberate — a real bug shipped where a
// stall could reach the cache (see isCacheableResult below for the fix)
// and then serve for up to RESULT_CACHE_TTL_MS to everyone else who
// pasted the same common input, in ~50ms, looking exactly like a real
// response. Bumping the key prefix orphans every entry any earlier
// deploy might have written — a real purge, not just a promise that the
// write-side bug is fixed now — and isCacheableResult below is checked
// on BOTH read and write so a bad entry can never be written OR served
// again even if something upstream of this function regresses.
const RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function resultCacheKey(sent) {
  return "result2:" + normalizeBefore(sent);
}
// The only gate for whether a result belongs in this cache at all: real
// drafts, from a real model, none of them the client-side stall line.
// `source` alone (the "model" vs "stall" distinction computed once, at
// the bottom of the handler, off `positions.length`) would be enough on
// its own — this also checks `drafts` directly so a future edit that
// forgets to update `source` in lockstep still can't slip a stall
// through either check alone.
function isCacheableResult(source, drafts) {
  return source === "model" && Array.isArray(drafts) && drafts.length > 0 &&
    drafts.every(function (d) { return d && d.lane !== "stall"; });
}
function cacheResult(sent, payload) {
  if (!isCacheableResult(payload.source, payload.drafts)) return;
  stragglerCache.set(resultCacheKey(sent), { payload: payload, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });
}
function getCachedResult(sent) {
  const key = resultCacheKey(sent);
  const entry = stragglerCache.get(key);
  if (!entry || entry.expiresAt < Date.now() || !isCacheableResult(entry.payload.source, entry.payload.drafts)) {
    if (entry) stragglerCache.delete(key);
    return null;
  }
  return entry.payload;
}

// Persistent pre-warm store (lib/precomputed.js, written by api/cron/
// precompute.js), consulted only on an in-memory miss. A hit is copied into
// the in-memory cache too, so this container doesn't ask Supabase again for
// the same text. Same isCacheableResult gate as every other cache path.
async function fromPrecomputed(sent) {
  const p = await getPrecomputed(sent);
  if (!p || !isCacheableResult(p.source, p.drafts)) return null;
  cacheResult(sent, p);
  return p;
}

function newStages() {
  return {
    t_cold: 0,
    t_parse: 0,
    t_block: 0,
    t_wildcardA: 0, // wall-clock of Hermes call A (shock, raunchy, gross), including any retry/fallback — runs parallel to B
    t_wildcardB: 0, // wall-clock of Hermes call B (shock, raunchy, gross) — see this file's own header comment for why the room is split into two calls
    t_wildcard: 0,  // max(t_wildcardA, t_wildcardB) — the wall-clock cost of the Hermes step as a whole, not their sum
    t_judge: 0,    // wall-clock of safety+taste running CONCURRENTLY (see the handler) — not their sum
    t_response: 0
  };
}

function formatStages(s) {
  return "t_cold=" + s.t_cold + "ms t_parse=" + s.t_parse + "ms t_block=" + s.t_block + "ms" +
    " t_wildcardA=" + s.t_wildcardA + "ms t_wildcardB=" + s.t_wildcardB + "ms t_wildcard=" + s.t_wildcard + "ms" +
    " t_judge=" + s.t_judge + "ms t_response=" + s.t_response + "ms";
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

// One call to the wildcard/Hermes generator — the only generator left
// (see this file's own header). `kind` is carried into `why`/logs for
// ?debug=1 and into callLLM's genOpts, though lib/llm.js itself no longer
// branches on it now that buildWildcardRequest is its only builder.
// extractPremiseCandidates (lib/postprocess.js) still parses the
// response — the wildcard prompt dropped premise-first (see lib/
// prompt.js's own header), so `premises` now comes back empty every time,
// but the shape it parses ({candidates: [...]}, premises defaulting to an
// empty array when absent) needed no change to keep working. `premises`
// still rides on the returned result into `debug` for symmetry with past
// runs — never shown to a visitor, and always null now in practice.
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

// Best-effort classification of WHY a request stalled (survivors.length
// === 0 after the full generate-then-judge round) — logged in `why` and
// returned as its own `stall_reason` field so index.html can log it as a
// "stall" event (see api/event.js's own header) without ever having to
// parse `why`'s own free text itself. Seven named reasons, checked in
// the order that actually explains "why zero candidates survived":
//   - "credits" — OpenRouter itself returned HTTP 402 (Payment Required
//     — the account is out of credits). Checked FIRST and ahead of
//     everything else: a real production incident traced every stall in
//     a whole window back to exactly this, and it's the one reason that
//     isn't really "the model had a bad moment" — it's "every call is
//     going to keep failing until someone tops up the account." Also
//     console.error'd immediately, at error level, specifically so it
//     shows up in Vercel's own function logs without anyone having to go
//     dig a stall_reason back out of a client report first.
//   - "rate limit" / "parse" / "fallback timeout" / "primary timeout" —
//     generation itself produced nothing (wildcard.lines is empty).
//     Distinguished by scanning wildcard.why (the merged A+B string —
//     see runGenerationRound) for the signal each failure mode leaves:
//     an HTTP 429 from the upstream LLM, an unparsable/token-limit
//     response, or a timeout. A timeout tagged "(fallback)" (see
//     tagModel/runGenerator — FALLBACK_MODEL was tried and ALSO timed
//     out) reports as "fallback timeout"; anything else timeout-shaped
//     (untagged, or "(retry)" — same model, a second attempt) reports as
//     "primary timeout". This is a best-effort read of a string built
//     from two parallel calls' own outcomes, not a precise trace — good
//     enough to point at the right log line, not a substitute for
//     reading wildcard.why itself in Vercel's own logs.
//   - "judge-eliminated-all" — real candidates existed, but not one of
//     them cleared the taste judge's own gates (continues/anchor/turn/
//     clear).
//   - "safety-eliminated-all" — real candidates existed and at least one
//     cleared the gates, but every one of those got flagged by the
//     safety judge instead (or the taste call itself failed and the
//     fixed-lane-order fallback still came back empty, which can only
//     happen the same way: safety flagged everything).
// Only ever called when survivors.length is already known to be 0 —
// this doesn't re-check that itself. Never cached either way: this only
// ever runs when drafts.length is 0 (source:"stall"), and
// isCacheableResult's own gate already refuses any non-"model" source
// regardless of which stall_reason produced it — a 402 gets the exact
// same "never sticks around for 24 hours" treatment as every other
// stall, nothing extra needed here for that part.
function classifyStallReason(wildcard, taste) {
  const why = String(wildcard.why || "");
  if (!wildcard.lines || !wildcard.lines.length) {
    if (/\bllm 402\b/i.test(why)) {
      console.error("OpenRouter 402 (out of credits) — every call is going to keep failing until this is topped up: " + why);
      return "credits";
    }
    if (/\brate.?limit\b|\bhttp 429\b/i.test(why)) return "rate limit";
    if (/no json in output|hit token limit|unparsable/i.test(why)) return "parse";
    if (/timed out/i.test(why)) {
      return /\(fallback\)/i.test(why) ? "fallback timeout" : "primary timeout";
    }
    return "primary timeout";
  }
  if (taste.ok) {
    const gateSurvivors = taste.details.filter(function (d) { return !d.eliminated; });
    if (!gateSurvivors.length) return "judge-eliminated-all";
  }
  return "safety-eliminated-all";
}

// Same retry-then-fallback shape as v3's own: every line filtered gets one
// retry on the SAME model (temperature is 1.0, so a second draw is often
// clean even when the first wasn't); an outright refusal, parse failure,
// or thrown error gets one attempt on FALLBACK_MODEL instead — a
// different provider entirely from WILDCARD_MODEL, so a bad day for one
// upstream doesn't take out both attempts.
const FALLBACK_MODEL = "mistralai/mistral-large-2512";

// Short label for which model actually wrote a response's drafts, carried
// as `gen_model` on the response (and inside a cached payload) so
// index.html can log it in draft_shown's meta.
function modelTag(model) {
  if (/astra/i.test(model)) return "astra";
  if (/hermes/i.test(model)) return "hermes";
  return model;
}
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

// Set once bump_inbox comes back 404 (scripts/precompute-schema.sql not run
// yet), so the plain upsert below is used directly for a few minutes instead
// of paying a doomed extra round trip on every request.
let bumpMissingUntil = 0;

// Fires via waitUntil (see the handler below), not awaited before
// responding. See lib/legacy/ commit history for the fuller "why waitUntil"
// story — unchanged from v2/v3.
//
// Prefers the bump_inbox SQL function (upsert that also counts repeat
// pastes in inbox.hits — what api/cron/precompute.js ranks by); falls back
// to the original plain upsert if that function isn't installed yet, so
// inbox logging never depends on the SQL having been run.
async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const started = Date.now();
  try {
    const d = dedupeKey(sent);
    const row = { key: d.key, sent: d.masked.trim().slice(0, 500) };
    const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
    const base = url.replace(/\/+$/, "") + "/rest/v1/";
    let res = null;
    if (Date.now() >= bumpMissingUntil) {
      res = await fetch(base + "rpc/bump_inbox", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ p_key: row.key, p_sent: row.sent })
      });
      if (res.status === 404) { bumpMissingUntil = Date.now() + 5 * 60 * 1000; res = null; }
    }
    if (!res) {
      res = await fetch(base + "inbox?on_conflict=key", {
        method: "POST",
        headers: Object.assign({ Prefer: "return=minimal,resolution=merge-duplicates" }, headers),
        body: JSON.stringify(row)
      });
    }
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
async function forgetImpl(sent) {
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

// Which of the judged survivors (q-descending, safety-flagged already gone)
// a visitor actually sees, in order — the position-selection loop the
// handler's own comment above describes: position 1 is the highest-q
// eligible survivor, positions 2 and 3 have to be at least as intense
// (reaction) as the position right before them, and every pick has to clear
// per-response diversity (lib/postprocess.js's createDiversityTracker).
//
// Lane caps on top of that, enforced here mechanically rather than trusted
// to the prompt: at most one lane:raunchy and at most one lane:gross line
// across the shown positions, and — on an INVITED text (lib/prompt.js's
// invitesRaunchy) — gross never
// wins: it's ineligible for positions 1 and 2 and can only take position 3,
// so a text that invited a proposition doesn't lead with a bodily gag. If
// nothing but gross survived an invited text, the cap is relaxed rather than
// stalling a request that has drafts (`relaxed` says so, for `why`).
function selectPositions(survivors, invited, fillEmpty) {
  const tracker = createDiversityTracker();
  const positions = [];
  let raunchyUsed = false;
  let grossUsed = false;
  function eligible(s, slot, relaxGross) {
    const lane = s.candidate.lane;
    if (lane === "raunchy" && raunchyUsed) return false;
    if (lane === "gross" && grossUsed) return false;
    if (lane === "gross" && invited && slot < 3 && !relaxGross) return false;
    return true;
  }
  function take(s) {
    positions.push(s);
    tracker.record(s.candidate.text);
    if (s.candidate.lane === "raunchy") raunchyUsed = true;
    if (s.candidate.lane === "gross") grossUsed = true;
  }
  let relaxed = false;
  let first = survivors.filter(function (s) { return eligible(s, 1, false); })[0];
  if (!first && survivors.length) { first = survivors[0]; relaxed = true; }
  if (first) take(first);
  for (let need = 2; need <= 3 && positions.length === need - 1; need++) {
    const prev = positions[need - 2];
    // survivors is q-descending, so the first one clearing the reaction
    // bar is the highest-q qualifier — no separate re-sort needed.
    const next = survivors.filter(function (s) {
      return positions.indexOf(s) === -1 && eligible(s, need, relaxed) &&
        (prev.reaction == null || s.reaction >= prev.reaction) &&
        !tracker.isDuplicate(s.candidate.text);
    })[0];
    if (!next) break;
    take(next);
  }
  // First show always ships three (when three lines exist): if the reaction
  // chain above left a slot empty, fill it with the highest-q remaining line
  // that still clears the lane caps and diversity — a less intense second
  // card beats an empty one on a first show. Never on escalation (fillEmpty
  // false): a "make it worse" tap that reveals something LESS intense reads
  // as a reroll, so there the chain stays strict.
  let chainRelaxed = 0;
  if (fillEmpty) {
    while (positions.length < 3) {
      const next = survivors.filter(function (s) {
        return positions.indexOf(s) === -1 && eligible(s, positions.length + 1, relaxed) && !tracker.isDuplicate(s.candidate.text);
      })[0];
      if (!next) break;
      take(next);
      chainRelaxed++;
    }
  }
  positions.relaxed = relaxed;
  positions.chainRelaxed = chainRelaxed;
  return positions;
}

// Survivors from two rounds as one q-ordered list (each candidate once, by
// text), with lib/judge.js's demoteUnjudged re-applied across the union so a
// safety-fail-open line still can't lead while a judged one exists.
function mergeSurvivors(a, b, unjudged) {
  const seen = new Set(a.map(function (s) { return s.candidate.text; }));
  const merged = a.concat(b.filter(function (s) { return !seen.has(s.candidate.text); }));
  merged.sort(function (x, y) {
    const qx = x.q == null ? -Infinity : x.q, qy = y.q == null ? -Infinity : y.q;
    return qx === qy ? 0 : (qy > qx ? 1 : -1);
  });
  return demoteUnjudged(merged, unjudged);
}
function unionSets(a, b) {
  const out = new Set(a || []);
  (b || []).forEach(function (x) { out.add(x); });
  return out;
}

const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];

// `internal` is null for every real request (the exported handler below).
// It's only ever set by runPrecompute, in-process, from api/cron/
// precompute.js — never derived from anything in the request, so no public
// caller can reach it. When set ({model, costSink}): the generator is
// `internal.model` (not WILDCARD_MODEL) with a long per-call timeout and
// cost accounting; the rate limiter, the inbox write/forget (a nightly
// re-run of texts already in the inbox must not inflate their hit counts),
// every cache read, and the in-memory cache write are skipped; and the
// response carries `fell_back`/`safety_failed_open` so the cron can refuse
// to store a result it shouldn't trust. Everything else — keyword block,
// crisis pre-check, curated bank, generation, safety, taste, regen, position
// selection — is the exact same code the live path runs.
async function handle(req, res, internal) {
  // Inside this function only: no-ops in internal mode (nothing here should
  // outlive the cron's own request, or delete the inbox row it's reading).
  const waitUntil = internal ? function () {} : waitUntilImpl;
  const forget = internal ? async function () { return null; } : forgetImpl;
  const stages = newStages();
  stages.t_cold = Date.now() - MODULE_LOADED_AT;
  // Unconditional, before any branch (block/curated/crisis/refuse/model) —
  // t_cold is already computed for every request regardless of how it
  // ends up being answered; this just makes sure every one of those paths
  // actually surfaces it, in Vercel's own function logs (for a quick "is
  // keep-warm actually working" check without a Supabase query) and,
  // where noted below, in the JSON response itself so index.html can fold
  // it into the funnel (see scripts/funnel.sql's own t_cold query).
  console.log("t_cold=" + stages.t_cold + "ms");

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
  // A clear, specific message — this used to just say "slow down", which
  // index.html's own submit handler had no special handling for at all:
  // a 429 fell through to res.json() same as any other response, parsed
  // as {error:...} with no `drafts`, and rendered as the generic "even
  // the draft wouldn't send that" refusal line — indistinguishable from
  // an actual refused input. index.html now checks res.status === 429
  // before ever parsing the body, for both a first-show submit and an
  // escalation fetch, and shows this message specifically.
  if (!internal && limited(ip)) { res.status(429).json({ error: "slow down — too many requests. wait a moment and try again." }); return; }

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
  const rememberPromise = internal ? Promise.resolve(null) : remember(sent);
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
        t_cold: stages.t_cold,
        t_total: Date.now() - requestStarted,
        // A curated match never runs the classifier below (or even reaches
        // it) — hand-picked benign text needs neither check, but the
        // client's "safety" event still expects a state/source on every
        // response, so this says so explicitly rather than leaving it out.
        safety: { state: "clear", source: "curated" }
      });
      return;
    }

    // Result cache — a repeated first-show input (same normalized text,
    // within RESULT_CACHE_TTL_MS of the last real generation for it —
    // see cacheResult/getCachedResult above) skips generation and judging
    // entirely. Checked after curated (curated is already instant, no
    // model call either way) and before the crisis pre-check and
    // generation below — a cache hit means neither of those needs to run
    // again for text that already cleared them once.
    const cached = internal ? null : (getCachedResult(sent) || await fromPrecomputed(sent));
    if (cached) {
      // This request was already counted against `ip`'s quota at the top
      // of the handler, before it was known this would turn out to be
      // free — undo that now (see lib/rateLimit.js's own release()). A
      // repeated common input shouldn't burn down a visitor's rate limit
      // for something that costs this server nothing.
      limited.release(ip);
      res.status(200).json({
        sent: sent,
        drafts: cached.drafts,
        source: cached.source,
        why: (cached.why || "") + " · cache: hit",
        provider: cached.provider,
        logged: logged,
        weak_lead: cached.weak_lead,
        gen_model: cached.gen_model || null,
        debug: cached.debug,
        t_gen: null,
        t_judge: null,
        t_cold: stages.t_cold,
        t_total: Date.now() - requestStarted,
        safety: cached.safety
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
      stall_reason: "no api key",
      why: "no api key",
      provider: null,
      logged: logged,
      debug: null,
      t_gen: null,
      t_judge: null,
      t_cold: stages.t_cold,
      t_total: Date.now() - requestStarted,
      safety: { state: crisisResult.state, source: "classifier" }
    });
    return;
  }

  // Internal (pre-warm) only: nobody is waiting, so gate generation on the
  // crisis pre-check instead of racing it — a text whose check didn't come
  // back "clear" (crisis, or the classifier itself failed open) can't be
  // stored anyway, so don't pay for generating it. Live requests keep the
  // concurrent race described above.
  if (internal) {
    const pre = await crisisPromise;
    const preSafety = { state: pre.state, source: "classifier" };
    if (pre.crisis) { res.status(200).json({ crisis: true, source: "model", drafts: [], safety: preSafety }); return; }
    if (pre.state !== "clear") { res.status(200).json({ source: "stall", drafts: [], stall_reason: "crisis check " + pre.state, safety: preSafety }); return; }
  }

  // Whether the sent text invites a raunchy line — decided here, in code
  // (lib/prompt.js's invitesRaunchy), never left to the model. Sets both
  // calls' lane plans, and gates what selectPositions lets gross do.
  const lanePlans = lanePlansFor(sent);
  const invited = lanePlans.invited;

  const genOpts = Object.assign({ escalate: escalate, shown: shown }, internal ? { timeoutMs: 60000, costSink: internal.costSink } : {});
  const genModel = internal && internal.model ? internal.model : WILDCARD_MODEL;

  // One full generate-then-judge pass — Hermes' two calls, safety+taste
  // running concurrently on the combined candidate set. Factored into its
  // own function because regenerate-if-weak (below) can run this exact
  // sequence a second time — never more than once, whatever the second
  // round's own result turns out to be.
  // Every timing lands in a LOCAL object, not the outer `stages` directly,
  // so running this twice doesn't leave `stages` reporting a discarded
  // round's numbers — the caller copies whichever round it actually keeps
  // into `stages` once that's decided.
  // `extraGenOpts` (optional) is merged over genOpts for both generator
  // calls — today only { gate1Retry: true } (see lib/prompt.js's
  // buildGate1RetryBlock), for the regen round after a gate-1 wipeout.
  async function runGenerationRound(extraGenOpts) {
    const t = { t_wildcardA: 0, t_wildcardB: 0, t_wildcard: 0, t_judge: 0 };

    // Each call's own slot, plus whether it's settled yet — the soft
    // deadline below needs to inspect exactly which calls are already
    // done at the deadline, not just "some subset finished." The promise
    // itself is untouched either way: a call past the deadline isn't
    // cancelled, it just isn't awaited for this response — see the
    // soft-deadline branch below for what happens to it instead.
    // wildcardA/wildcardB are the two halves of the Hermes room (see this
    // file's own header comment for why one big call became two smaller
    // parallel ones) — the only two calls this function ever makes now.
    const slots = {
      wildcardA: { settled: false, result: null },
      wildcardB: { settled: false, result: null }
    };
    const wildcardAStarted = Date.now();
    const wildcardAPromise = runGenerator(key, genModel, sent, "wildcard", Object.assign({ lanes: lanePlans.A }, genOpts, extraGenOpts))
      .then(function (r) { t.t_wildcardA = Date.now() - wildcardAStarted; slots.wildcardA.settled = true; slots.wildcardA.result = r; return r; });
    const wildcardBStarted = Date.now();
    const wildcardBPromise = runGenerator(key, genModel, sent, "wildcard", Object.assign({ lanes: lanePlans.B }, genOpts, extraGenOpts))
      .then(function (r) { t.t_wildcardB = Date.now() - wildcardBStarted; slots.wildcardB.settled = true; slots.wildcardB.result = r; return r; });
    const allPromises = { wildcardA: wildcardAPromise, wildcardB: wildcardBPromise };

    // Soft deadline: wait up to GENERATION_SOFT_DEADLINE_MS for both
    // calls. If both are done by then (the common case — this is a race
    // against a timer, not a fixed delay), this behaves exactly like the
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
    // own count is (lanePlansFor's A/B length) — the threshold has
    // to be clearable by ONE half landing alone, or it's not really a
    // soft deadline firing, just Promise.all resolving early once BOTH
    // halves happen to finish.
    const GENERATION_SOFT_DEADLINE_MS = internal ? 90000 : 3500;
    const MIN_CANDIDATES_FOR_SOFT_DEADLINE = 3;
    let lateGroupCount = 0;
    // Kept in scope past the soft-deadline dance below (not just inside
    // the branch that sets it) — the stall-rescue path further down
    // (right before this function returns) needs to know whether there's
    // still a call in flight worth waiting a little longer for, on the
    // rare request where everything else got eliminated.
    let pendingPromisesInFlight = [];
    await Promise.race([Promise.all([wildcardAPromise, wildcardBPromise]), sleep(GENERATION_SOFT_DEADLINE_MS)]);

    const pendingKeys = Object.keys(slots).filter(function (k) { return !slots[k].settled; });
    let wildcardA, wildcardB;
    if (!pendingKeys.length) {
      wildcardA = slots.wildcardA.result;
      wildcardB = slots.wildcardB.result;
    } else {
      const inHandCount = Object.keys(slots).reduce(function (sum, k) { return sum + (slots[k].settled ? (slots[k].result.lines || []).length : 0); }, 0);
      if (inHandCount >= MIN_CANDIDATES_FOR_SOFT_DEADLINE) {
        lateGroupCount = pendingKeys.length;
        const pendingFallback = { lines: [], why: "pending past " + GENERATION_SOFT_DEADLINE_MS + "ms soft deadline", provider: null, premises: null };
        wildcardA = slots.wildcardA.settled ? slots.wildcardA.result : pendingFallback;
        wildcardB = slots.wildcardB.settled ? slots.wildcardB.result : pendingFallback;
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
        const all = await Promise.all([wildcardAPromise, wildcardBPromise]);
        wildcardA = all[0];
        wildcardB = all[1];
      }
    }

    // Merges the two Hermes sub-calls back into the single `wildcard`
    // shape every downstream consumer already expects (lines/why/
    // provider/premises/debugLines/t_gen/skip) — nothing past this point
    // in the function, or in the outer handler, needs to know there were
    // two calls instead of one. `skip` is true if EITHER half refused.
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

    // Hermes is the only generator — declining outright is a full refusal.
    if (wildcard.skip) {
      return { refuse: true, wildcard: wildcard, t: t };
    }

    // On an escalation request specifically, pick up any stragglers an
    // earlier (non-escalation) request for this same text left running
    // past its own soft deadline — see cacheStragglers/takeStragglers
    // above. A no-op (empty array) whenever there's nothing cached, which
    // is the ordinary case — most escalation requests won't have a
    // straggler waiting for them.
    const stragglers = (escalate ? takeStragglers(sent) : []).filter(function (c) { return invited || c.lane !== "raunchy"; });
    // A text with no invitation token never gets a raunchy candidate, even
    // if the model wrote one anyway (its slot was deranged — see lanePlansFor).
    const freshCandidates = (wildcard.lines || []).filter(function (c) { return invited || c.lane !== "raunchy"; });
    // Judged pool cap — relevant on an escalation refetch specifically;
    // first-show's own fresh candidates never get close to this on their
    // own (six candidates from Hermes — see this file's own header
    // comment). On escalation, a large straggler cache could otherwise
    // pile on top of a full fresh batch, taking safety+taste's own
    // latency well past what a "make it worse" tap should cost.
    // Stragglers only BACKFILL — they fill the gap when this round's own
    // fresh generation came back short of the cap, never just get
    // appended on top of a full one.
    const JUDGED_POOL_CAP = 8;
    const backfillRoom = Math.max(0, JUDGED_POOL_CAP - freshCandidates.length);
    const stragglersUsed = stragglers.slice(0, backfillRoom);
    const allCandidates = freshCandidates.concat(stragglersUsed).slice(0, JUDGED_POOL_CAP);

    // Judges one candidate list — SAFETY and TASTE running CONCURRENTLY,
    // not safety-then-taste gating what taste even sees (taste judges
    // every candidate in parallel with safety judging every candidate,
    // and only once both are back does a safety flag remove a candidate
    // from the ranking). Position 1 is simply the top-q survivor once
    // that's done — no pairwise final anymore (see this file's own header
    // comment). Factored out of what used to be this function's own
    // inline body so the stall-rescue path below (a straggler landing
    // just after everything else got eliminated) can re-run this exact
    // judging on a second, smaller candidate list without duplicating it
    // — the ordinary path just below calls this exactly once, same
    // behavior as before this existed.
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
      // Candidates whose safety check failed OPEN (verdict null: both the
      // primary and the fallback model failed) — they're never removed, but
      // they never got a real verdict either, so `survivors` below demotes
      // them behind every line that did (see lib/judge.js's demoteUnjudged).
      const unjudged = new Set();
      candidates.forEach(function (item, i) {
        const result = safetyVerdicts[i];
        safetyLatencyTotal += result.latencyMs || 0;
        if (result.latencyMs != null && result.latencyMs > safetyMaxLatency) safetyMaxLatency = result.latencyMs;
        if (result.model && safetyModelsSeen.indexOf(result.model) === -1) safetyModelsSeen.push(result.model);
        if (result.verdict === null) { safetyFailedCount++; unjudged.add(item); }
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
        (safetyFailedCount ? " (" + safetyFailedCount + " failed open, demoted behind judged lines)" : "") +
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
        // Ranked by q, safety-flagged removed, then any line safety never
        // actually judged (failed open) moved behind every line it did —
        // so position 1 is a judged line whenever one exists.
        survivors = demoteUnjudged(taste.ranked.filter(function (r) { return !flagged.has(r.candidate); }), unjudged);
        // Every candidate's q/reaction, and the gate that killed each
        // eliminated one — exactly what ?debug=1 needs to see the
        // judge's actual reasoning, not just its final picks. A safety-
        // flagged candidate is tagged here too, whatever taste made of
        // it, since that's exactly why it's missing from `survivors`
        // above.
        const totalsNote = taste.details.map(function (d) {
          const flag = flagged.has(d.candidate) ? " [safety-flagged]" : (unjudged.has(d.candidate) ? " [safety failed open]" : "");
          return "[" + d.lane + "] " + (d.eliminated ? "elim:" + d.killedBy : "q:" + d.q + " reaction:" + d.reaction) + flag;
        }).join(", ");
        tasteNote = "taste: " + taste.model + " (" + (taste.latencyMs || 0) + "ms) — " + totalsNote;
      } else {
        // Fallback: fixed lane order — still a reasonable "something is
        // better than nothing" ordering, just not the ranked-by-taste/
        // intensity one. There's no real q/reaction to gate escalation
        // on here, so every position below just takes the next lane-
        // ordered survivor.
        survivors = demoteUnjudged(candidates
          .filter(function (item) { return !flagged.has(item); })
          .sort(function (a, b) { return ALL_LANES.indexOf(a.lane) - ALL_LANES.indexOf(b.lane); })
          .map(function (item) { return { candidate: item, q: null, reaction: null }; }), unjudged);
        tasteNote = "taste: failed open (" + taste.reason + ") — fell back to fixed lane order";
      }

      return { taste: taste, survivors: survivors, safetyNote: safetyNote, tasteNote: tasteNote, tJudge: tJudge, safetyFailedCount: safetyFailedCount, unjudged: unjudged };
    }

    let judged = await judgeAndRank(allCandidates);
    t.t_judge += judged.tJudge;
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
    // doesn't retroactively update `wildcard` (still whichever
    // placeholder it got at the soft deadline) — the actual response
    // ships the rescued draft correctly, `?debug=1`'s own generator panel
    // just won't show where it came from. Not worth the extra bookkeeping
    // for a rescue that, by definition, only fires when the ordinary path
    // already came back with nothing to show.
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
        const rescueCandidates = rescue.results.reduce(function (acc, r) { return acc.concat(r.lines || []); }, [])
          .filter(function (c) { return invited || c.lane !== "raunchy"; });
        if (!rescueCandidates.length) {
          stallRescueNote = "stall rescue: pending call(s) landed after " + rescueWaitMs + "ms with nothing usable — stalling";
        } else {
          const rescued = await judgeAndRank(rescueCandidates);
          t.t_judge += rescued.tJudge;
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
      refuse: false, wildcard: wildcard, taste: judged.taste,
      safetyNote: judged.safetyNote, tasteNote: judged.tasteNote,
      survivors: judged.survivors, safetyFailedCount: judged.safetyFailedCount, unjudged: judged.unjudged, t: t, lateGroupCount: lateGroupCount, stragglerPickupCount: stragglerPickupCount,
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

  // Regenerate-if-weak, on the reaction gate alone now. v4 originally had
  // two separate triggers — a q-based REGEN_THRESHOLD (carried over from
  // v3, re-tuned for v4's new formula) plus this reaction floor — but
  // REGEN_THRESHOLD was calibrated against a q range that's since moved
  // out from under it (lib/prompt.js's own lane cuts and judge rewrites
  // changed what a "good" q even looks like) and was firing on almost
  // every request, not just the weak ones it was meant to catch. Gone
  // entirely rather than re-calibrated again — REACTION_LEAD_GATE is the
  // one number that's actually meant something consistent across every
  // rewrite: does position 1 clear reaction >= 6, the same floor the v4
  // addendum (section F) added to name the BORED failure mode (a
  // technically-decent q with no actual reaction) lib/judge.js's
  // calibration block exists to catch. Capped at exactly one extra round
  // no matter how the second round itself scores — this is a retry, not
  // a search for perfect. A second round that comes back an outright
  // refusal just keeps the first round's (already-known-good) result
  // rather than failing a request that had already succeeded once.
  const REACTION_LEAD_GATE = 6;
  function bestReactionOf(r) { return r.survivors.length && r.survivors[0].reaction != null ? r.survivors[0].reaction : null; }

  // Never on an escalation refetch — a real production hang (45s in an
  // outside test) traced back to exactly this: regenerate-if-weak used
  // to fire regardless of `escalate`, so a weak-scoring "make it worse"
  // round could pay for a SECOND full generate-then-judge round on top
  // of an already-slow one, with no client-side timeout (see
  // index.html's own fetchEscalation) to ever give up waiting. One tap
  // now means one round, worst case, full stop — JUDGED_POOL_CAP already
  // exists to keep an escalation round itself cheap; this is what
  // actually keeps the ROUND COUNT from doubling on top of that.
  let regenerated = false;
  const firstRoundBestReaction = bestReactionOf(round);
  // A gate-1 wipeout — the taste judge ran and eliminated EVERY candidate at
  // gate 1 (`continues`: the recipient replying, not the sender continuing).
  // Survivors are empty, so firstRoundBestReaction is null and the weak-lead
  // check below can't see it; without this the request would just stall. One
  // retry, told exactly what went wrong (lib/prompt.js's
  // buildGate1RetryBlock). Same first-show-only, one-extra-round cap as the
  // weak-lead regen.
  function eliminatedEverythingAtGate1(r) {
    const d = r.taste && r.taste.ok ? r.taste.details : null;
    return !!d && d.length > 0 && d.every(function (x) { return x.eliminated && x.killedBy === "continues"; });
  }
  // Hard cap on total request time for any extra round: a retry (weak lead,
  // gate-1 wipeout, or the fill round below) only runs if the time already
  // spent plus what the first round cost fits inside REQUEST_BUDGET_MS.
  // Otherwise ship what survived. No cap in internal (pre-warm) mode —
  // nobody is waiting, and Astra's rounds never fit 10s anyway.
  const REQUEST_BUDGET_MS = internal ? Infinity : (Number(process.env.REQUEST_BUDGET_MS) || 10000); // env override is for tests only
  const firstRoundCostMs = (round.t.t_wildcard || 0) + (round.t.t_judge || 0);
  function retryFits() { return (Date.now() - requestStarted) + firstRoundCostMs <= REQUEST_BUDGET_MS; }
  let regenSkippedNote = "";

  const gate1Wipeout = !escalate && eliminatedEverythingAtGate1(round);
  const needsRegen = gate1Wipeout || (!escalate && firstRoundBestReaction != null && firstRoundBestReaction < REACTION_LEAD_GATE);
  if (needsRegen && !retryFits()) {
    regenSkippedNote = " · regen skipped: would exceed " + REQUEST_BUDGET_MS + "ms";
  } else if (needsRegen) {
    const regenRound = await runGenerationRound(gate1Wipeout ? { gate1Retry: true } : null);
    if (!regenRound.refuse) {
      // The first round's survivors aren't thrown away: they're merged in
      // behind (or ahead of, by q) the regen round's, so a regen that comes
      // back thin still has round one's lines to fill positions 2 and 3.
      const firstRound = round;
      round = regenRound;
      round.survivors = mergeSurvivors(regenRound.survivors, firstRound.survivors, unionSets(regenRound.unjudged, firstRound.unjudged));
      round.unjudged = unionSets(regenRound.unjudged, firstRound.unjudged);
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
  stages.t_judge = round.t.t_judge;
  const wildcard = round.wildcard;
  const taste = round.taste;
  const safetyNote = round.safetyNote;
  const tasteNote = round.tasteNote;
  let survivors = round.survivors;
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
  let positions = selectPositions(survivors, invited, !escalate);

  // First show always ships three. Fewer than three positions after the
  // round(s) above → one more generation round, its survivors merged with
  // this round's (q-ordered, safety demotion re-applied — see
  // mergeSurvivors), then positions are re-selected. Subject to the same
  // REQUEST_BUDGET_MS as every other retry — that budget, not a round count,
  // is what bounds this: a regen above already cost a round, so this rarely
  // still fits after one, and the note says so when it doesn't. Never on
  // escalation (one tap, one round — see needsRegen).
  let fillNote = "";
  // Zero survivors counts too: a round the judge wiped out (at any gate mix
  // that isn't the all-gate-1 case handled above) would otherwise stall on
  // first show without ever trying again — seen live on "you up?".
  if (!escalate && positions.length < 3) {
    if (!retryFits()) {
      fillNote = " · fill round skipped: would exceed " + REQUEST_BUDGET_MS + "ms";
    } else {
      const had = positions.length;
      const fill = await runGenerationRound();
      stages.t_judge += fill.t.t_judge || 0;
      if (!fill.refuse && fill.survivors.length) {
        const before = survivors.length;
        survivors = mergeSurvivors(survivors, fill.survivors, unionSets(round.unjudged, fill.unjudged));
        positions = selectPositions(survivors, invited, true);
        fillNote = " · fill round: had " + had + " shown, +" + (survivors.length - before) + " survivor(s), now " + positions.length + " shown";
      } else {
        fillNote = " · fill round: nothing usable (had " + had + " shown)";
      }
    }
  }

  // Pairwise final, narrowly: only when the top two survivors are within one
  // reaction point of each other — q alone can't be trusted to order them
  // then, and "the strongest candidate didn't appear first" is exactly what
  // that looks like. One extra judge call (~1s), first show only, and only
  // if it fits the request budget. A 2 verdict swaps them and re-selects
  // positions; a 1 keeps the order; a failed call changes nothing.
  const PAIRWISE_ALLOWANCE_MS = 2000;
  let pairwiseNote = "";
  if (!escalate && survivors.length >= 2 && survivors[0].reaction != null && survivors[1].reaction != null &&
      Math.abs(survivors[0].reaction - survivors[1].reaction) <= 1) {
    if ((Date.now() - requestStarted) + PAIRWISE_ALLOWANCE_MS > REQUEST_BUDGET_MS) {
      pairwiseNote = " · pairwise skipped: would exceed " + REQUEST_BUDGET_MS + "ms";
    } else {
      // Both orders, in parallel. Measured: gpt-5.4 answered "2" in every
      // single call regardless of which line was second — a position
      // bias, not a preference. So the second line only wins if it wins
      // from BOTH positions; anything else (including a split) keeps q
      // order. Wall cost is one call, not two.
      const top = survivors[0].candidate, second = survivors[1].candidate;
      const both = await Promise.all([judgePairwise(key, sent, top, second), judgePairwise(key, sent, second, top)]);
      const ab = both[0], ba = both[1];
      const ms = Math.max(ab.latencyMs || 0, ba.latencyMs || 0);
      stages.t_judge += ms;
      if (ab.winner === null || ba.winner === null) {
        pairwiseNote = " · pairwise failed (" + (ab.reason || ba.reason || "?") + "), q order kept";
      } else if (ab.winner === 2 && ba.winner === 1) {
        survivors = [survivors[1], survivors[0]].concat(survivors.slice(2));
        positions = selectPositions(survivors, invited, true);
        pairwiseNote = " · pairwise: #2 won from both positions (" + ms + "ms), swapped";
      } else if (ab.winner === 1 && ba.winner === 2) {
        pairwiseNote = " · pairwise: #1 won from both positions (" + ms + "ms), held";
      } else {
        pairwiseNote = " · pairwise: split verdict (" + ab.winner + "/" + ba.winner + " — position bias), q order kept";
      }
    }
  }

  // The reader asked for it: on a text that invites raunchy (lib/prompt.js's
  // invitesRaunchy), the best raunchy survivor leads if its reaction is
  // within one point of the top survivor's. q still decides everything else;
  // this only moves one line to the front, after pairwise has had its say.
  let raunchyLeadNote = "";
  if (invited && survivors.length > 1 && survivors[0].candidate.lane !== "raunchy") {
    const top = survivors[0];
    const bestRaunchy = survivors.filter(function (s) { return s.candidate.lane === "raunchy" && s.reaction != null; })[0];
    if (bestRaunchy && top.reaction != null && top.reaction - bestRaunchy.reaction <= 1) {
      survivors = [bestRaunchy].concat(survivors.filter(function (s) { return s !== bestRaunchy; }));
      positions = selectPositions(survivors, invited, !escalate);
      raunchyLeadNote = " · raunchy leads: invited, reaction " + bestRaunchy.reaction + " within 1 of top " + top.reaction;
    }
  }

  const responseStarted = Date.now();
  const drafts = positions.map(function (p, i) {
    return { lane: p.candidate.lane, text: p.candidate.text, q: p.q, reaction: p.reaction, position: i + 1 };
  });
  const source = drafts.length ? "model" : "stall";
  const stallReason = drafts.length ? null : classifyStallReason(wildcard, taste);
  if (!drafts.length) drafts.push({ lane: "stall", text: stallLine(), q: null, reaction: null, position: 1 });

  stages.t_response = Date.now() - responseStarted;
  const why = "wildcard: " + (wildcard.skip ? "skipped" : (wildcard.why || "?")) +
    " · " + safetyNote + " · " + tasteNote +
    (regenerated
      ? " · regen: true (" + (gate1Wipeout ? "every candidate eliminated at gate 1 — retried with the POV hint" : "first round best reaction " + firstRoundBestReaction + " < " + REACTION_LEAD_GATE) + ")"
      : "") +
    regenSkippedNote + fillNote + pairwiseNote + raunchyLeadNote +
    (positions.relaxed ? " · gross cap relaxed: nothing else survived an invited text" : "") +
    (positions.chainRelaxed ? " · reaction chain relaxed for " + positions.chainRelaxed + " slot(s) to ship three" : "") +
    (weakLead ? " · weak_lead: true (best reaction " + finalBestReaction + " < " + REACTION_LEAD_GATE + ")" : "") +
    (lateGroupCount ? " · late: " + lateGroupCount + " (proceeded past soft deadline, call(s) finishing in background)" : "") +
    (stragglerPickupCount ? " · stragglers picked up: " + stragglerPickupCount : "") +
    (stallRescueNote ? " · " + stallRescueNote : "") +
    (stallReason ? " · stall_reason: " + stallReason : "") +
    " · stages: " + formatStages(stages);

  // Which model actually wrote these drafts: genModel normally, but the
  // mistral fallback (see runGenerator) if either call had to fall back —
  // and internal callers are told so, to refuse to store that as an
  // Astra result.
  const fellBack = /\(fallback\)/i.test(String(wildcard.why || ""));
  const genTag = modelTag(fellBack ? FALLBACK_MODEL : genModel);
  const genTGen = wildcard.t_gen || null;
  const genProvider = wildcard.provider || null;
  // Hermes' own premises — always null now that the wildcard prompt
  // dropped premise-first (see lib/prompt.js's own header comment). Never
  // returned to the client's own display, only into `debug` for ?debug=1
  // to read.
  const premises = { wildcard: wildcard.premises || null };

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

  const debug = {
    wildcard: wildcard.debugLines || null,
    judge: taste.ok ? taste.details : null,
    premises: premises
  };
  const safetyField = { state: crisisResult.state, source: "classifier" };

  // Result cache — only a real, successfully-generated first-show result
  // (never escalation, never a stall) is worth serving again for
  // RESULT_CACHE_TTL_MS: see cacheResult's own comment above for why
  // escalation is excluded, and this file's own header for why the cache
  // exists at all. `!escalate` is checked here; cacheResult's own
  // isCacheableResult check is what actually refuses a stall (no API
  // key, or every candidate eliminated) — a transient failure shouldn't
  // become a sticky one for 24 hours.
  if (!escalate) {
    if (!internal) cacheResult(sent, { drafts: drafts, source: source, why: why, provider: genProvider, weak_lead: weakLead, debug: debug, safety: safetyField, gen_model: genTag });
  }

  res.status(200).json(Object.assign({
    sent: sent,
    drafts: drafts,
    source: source,
    stall_reason: stallReason,
    why: why || null,
    provider: genProvider,
    logged: logged,
    weak_lead: weakLead,
    gen_model: source === "model" ? genTag : null,
    debug: debug,
    t_gen: genTGen,
    t_judge: stages.t_judge,
    t_cold: stages.t_cold,
    t_total: t_total,
    safety: safetyField
  }, internal ? { fell_back: fellBack, safety_failed_open: round.safetyFailedCount || 0 } : {}));
}

module.exports = function handler(req, res) { return handle(req, res, null); };

// In-process only — api/cron/precompute.js. Runs one text through the full
// pipeline as `internal.model` and returns { code, body } instead of
// writing to a real response object.
module.exports.runPrecompute = async function runPrecompute(sent, internal) {
  const out = { code: 200, body: null };
  const res = {
    setHeader: function () {},
    status: function (c) { out.code = c; return res; },
    json: function (b) { out.body = b; return res; },
    end: function () { return res; }
  };
  await handle({ method: "POST", headers: {}, body: { sent: sent } }, res, internal);
  return out;
};

// Exported for scripts/ and tests only.
module.exports.selectPositions = selectPositions;

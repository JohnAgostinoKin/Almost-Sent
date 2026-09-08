// api/draft.js — v3: one request, ten candidates, three drafts back.
//
// v2 (see lib/legacy/) was two client requests per result: an n=1 lead
// (one shape, pickBest-of-N) then an n=4 alternates call for the same
// shape's siblings. v3 replaces both with ONE request that fires THREE
// generator calls in parallel — two primary calls (lib/prompt.js's
// buildPrimaryRequest, GENERATOR_MODEL), each writing one candidate per
// lane for four of the eight primary lanes (PRIMARY_LANES_A/B — same
// prompt shape, half the output each, merged before judging), plus the
// wildcard call (buildWildcardRequest, WILDCARD_MODEL) writing the
// raunchy and gross candidates — then judges all ten together and returns
// the top three, best first. Position 1 is the lead; "make it worse"
// reveals 2 and 3 instantly (already fetched, no second request); a third
// tap fires a fresh escalated request (see `escalate`/`shown` below)
// instead of the old client-side alternates refetch.
//
// Selection past generation is two separate jobs, run CONCURRENTLY on the
// full candidate set rather than one gating the other: SAFETY
// (lib/judge.js's judgeOneLine, cheap model, one call per candidate,
// unchanged from v2) checks every candidate for anything that shouldn't
// ship at all; TASTE (lib/judge.js's judgeCandidates, expensive model,
// split into two parallel batches) gates every candidate on five hard
// checks — does it actually continue their message, is the claimed anchor
// real and load-bearing, is there a turn, is it clear — then scores and
// ranks what's left. Once BOTH resolve, any candidate safety flagged is
// removed from the ranking regardless of what taste made of it. A failed
// taste call (timeout, unparsable reply — no retry; see lib/judge.js's
// header comment for why) falls back to fixed lane order rather than
// blocking the response on a second expensive call.

const { norm } = require("../lib/normalize");
const { callLLM } = require("../lib/llm");
const { GENERATOR_MODEL, WILDCARD_MODEL, PRIMARY_LANES_A, PRIMARY_LANES_B, ALL_LANES, normalizeBefore } = require("../lib/prompt");
const {
  extractArray, normalizeItem, isRefusal, filterLines, describeDrops
} = require("../lib/postprocess");
const { judgeOneLine, judgeCandidates } = require("../lib/judge");
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

function newStages() {
  return {
    t_cold: 0,
    t_parse: 0,
    t_block: 0,
    t_primary_a: 0, // wall-clock of the primary A (lanes 1-4) generator call, including any retry/fallback
    t_primary_b: 0, // same, for primary B (lanes 5-8) — A and B run in parallel with each other and with wildcard
    t_wildcard: 0,  // same, for the wildcard (raunchy/gross) call
    t_judge: 0,     // wall-clock of safety+taste running CONCURRENTLY (see the handler) — not their sum
    t_response: 0
  };
}

function formatStages(s) {
  return "t_cold=" + s.t_cold + "ms t_parse=" + s.t_parse + "ms t_block=" + s.t_block + "ms" +
    " t_primary_a=" + s.t_primary_a + "ms t_primary_b=" + s.t_primary_b + "ms t_wildcard=" + s.t_wildcard + "ms" +
    " t_judge=" + s.t_judge + "ms t_response=" + s.t_response + "ms";
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

// One call to one generator (primary or wildcard). `kind` picks which
// lib/prompt.js builder callLLM reaches for (see lib/llm.js) and is
// carried into `why`/logs for ?debug=1. Always uses extractArray — unlike
// v2's callOnce, there's no "n=1, so try the lenient bare-object parser"
// branch: both v3 generator calls always ask for an array (eight objects
// or two), never exactly one.
async function callOneGenerator(key, model, sent, kind, genOpts) {
  try {
    const result = await callLLM(key, model, sent, Object.assign({ kind: kind }, genOpts));
    const t_gen = result.latencyMs;
    const provider = result.provider || null;
    console.log("provider (" + kind + "): " + (provider || "unknown") + " (" + model + ")");
    const providerTag = provider ? " [" + provider + "]" : "";
    const parsed = extractArray(result.text);
    if (!parsed) {
      const why = result.finishReason === "length" ? "hit token limit" : (result.text ? "no json in output" : "empty output");
      console.error("parse failure (" + kind + ", " + why + ") model=" + model + " raw=" + JSON.stringify(String(result.text || "").slice(0, 800)));
      return { lines: [], why: why + providerTag, provider: provider, reason: "unparsable", t_gen: t_gen };
    }
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return { lines: [], skip: true, t_gen: t_gen };
    const filtered = filterLines(items, sent);
    const drops = describeDrops(filtered);
    if (!filtered.kept.length) {
      return { lines: [], why: (drops || "all " + items.length + " filtered") + providerTag, provider: provider, reason: "filtered", debugLines: filtered.all, t_gen: t_gen };
    }
    const why = "ok, kept " + filtered.kept.length + (drops ? " — " + drops : "") + providerTag;
    return { lines: filtered.kept, why: why, provider: provider, debugLines: filtered.all, t_gen: t_gen };
  } catch (err) {
    return { lines: [], why: /timeout/i.test(err.message) ? "timed out" : err.message, provider: null, reason: "error" };
  }
}

function tagModel(result, model, note) {
  if (result.why) result.why = result.why + " · model: " + model + (note ? " (" + note + ")" : "");
  return result;
}

// Same retry-then-fallback shape as v2's fromAi, applied per generator
// call: every line filtered gets one retry on the SAME model (temperature
// is 1.0, so a second draw is often clean even when the first wasn't); an
// outright refusal, parse failure, or thrown error gets one attempt on
// FALLBACK_MODEL instead. Was openai/gpt-5.4 — the same value
// GENERATOR_MODEL defaults to, which meant a "fallback" attempt after a
// gpt-5.4 failure just retried gpt-5.4 again, diversifying nothing. A
// different provider entirely now, so a bad day for OpenAI's models
// doesn't take out both attempts.
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
// story — unchanged from v2.
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
        drafts: curated,
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
  const crisisPromise = !escalate
    ? checkCrisis(process.env.LLM_API_KEY, sent)
    : Promise.resolve({ state: "skipped", crisis: false });

  const key = process.env.LLM_API_KEY;
  if (!key) {
    const crisisResult = await crisisPromise; // still resolve it so nothing is left dangling, even though there's no model call to gate on it
    res.status(200).json({
      sent: sent,
      drafts: [{ lane: "stall", text: stallLine() }],
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
  // Two primary calls, not one — same prompt shape as before (lanes
  // taught, escalation block, rules), each teaching and asking for only
  // four of the eight primary lanes (see lib/prompt.js's PRIMARY_LANES_A/
  // B). Fired alongside the wildcard call, three-way parallel.
  const genOptsA = Object.assign({ lanes: PRIMARY_LANES_A }, genOpts);
  const genOptsB = Object.assign({ lanes: PRIMARY_LANES_B }, genOpts);
  const primaryAStarted = Date.now();
  const primaryBStarted = Date.now();
  const wildcardStarted = Date.now();
  const [primaryA, primaryB, wildcard] = await Promise.all([
    runGenerator(key, GENERATOR_MODEL, sent, "primary", genOptsA).then(function (r) { stages.t_primary_a = Date.now() - primaryAStarted; return r; }),
    runGenerator(key, GENERATOR_MODEL, sent, "primary", genOptsB).then(function (r) { stages.t_primary_b = Date.now() - primaryBStarted; return r; }),
    runGenerator(key, WILDCARD_MODEL, sent, "wildcard", genOpts).then(function (r) { stages.t_wildcard = Date.now() - wildcardStarted; return r; })
  ]);

  const crisisResult = await crisisPromise;
  if (crisisResult.crisis) {
    waitUntil(rememberPromise.then(function () { return forget(sent); }));
    res.status(200).json({ crisis: true, source: "model", drafts: [], safety: { state: crisisResult.state, source: "classifier" } });
    return;
  }

  // Either primary half declining outright is a full refusal — same
  // convention as v2's lead skip, now just checked across two calls
  // instead of one. The wildcard call declining alone isn't: two lanes'
  // worth of "no" doesn't carry the same signal as a whole primary half
  // refusing, it just means no raunchy/gross candidates this round (rare
  // in practice — the wildcard prompt's own wall already covers the same
  // abusive/minor/threat ground).
  if (primaryA.skip || primaryB.skip) {
    waitUntil(rememberPromise.then(function () { return forget(sent); }));
    res.status(200).json({ refuse: true, drafts: [], safety: { state: crisisResult.state, source: "classifier" } });
    return;
  }

  const allCandidates = (primaryA.lines || []).concat(primaryB.lines || []).concat(wildcard.skip ? [] : (wildcard.lines || []));

  // SAFETY and TASTE run CONCURRENTLY on the full candidate set now, not
  // safety-then-taste gating what taste even sees — taste judges every
  // candidate in parallel with safety judging every candidate, and only
  // once both are back does a safety flag remove a candidate from the
  // ranking (see below). This costs a little redundant taste-judging on
  // whatever safety ends up flagging (rare), for real wall-clock savings:
  // total judge time is now roughly max(safety, taste), not their sum.
  //
  // lib/judge.js's judgeOneLine (safety, cheap model, one call per
  // candidate, unchanged from v2 apart from its renamed constants) and
  // judgeCandidates (taste, expensive model, split into two parallel
  // batches — see lib/judge.js's own comments for both).
  const judgeStarted = Date.now();
  const [safetyVerdicts, taste] = await Promise.all([
    allCandidates.length
      ? Promise.all(allCandidates.map(function (item) { return judgeOneLine(key, composeDraft(sent, item.text)); }))
      : Promise.resolve([]),
    allCandidates.length
      ? judgeCandidates(key, sent, allCandidates)
      : Promise.resolve({ ok: false, reason: "no candidates" })
  ]);
  stages.t_judge = Date.now() - judgeStarted;

  const safetyModelsSeen = [];
  let safetyLatencyTotal = 0;
  let droppedSafetyCount = 0;
  let safetyFailedCount = 0;
  let safetyRateLimitedCount = 0;
  const safetyReasons = [];
  // Candidates safety flagged — checked by identity (the exact objects in
  // allCandidates, which is also what taste.ranked/taste.details.candidate
  // reference) against both the ranking and the fallback ordering below,
  // regardless of what taste made of the same candidate.
  const flagged = new Set();
  allCandidates.forEach(function (item, i) {
    const result = safetyVerdicts[i];
    safetyLatencyTotal += result.latencyMs || 0;
    if (result.model && safetyModelsSeen.indexOf(result.model) === -1) safetyModelsSeen.push(result.model);
    if (result.verdict === null) safetyFailedCount++;
    // Every call's own latency, always — not just failures — so a slow
    // stretch (queueing, an upstream having a bad day) is visible in the
    // logs without a failure to trigger it. This is what actually caught
    // the connection-pool contention behind "safety nano at 3.6s for ten
    // calls" (see lib/judge.js's safetyDispatcher comment) — no 429s ever
    // showed up in it, which is exactly how that turned out not to be
    // rate limiting.
    console.log("safety [" + (item.lane || "?") + "] latencyMs=" + (result.latencyMs != null ? result.latencyMs : "?"));
    // result.reason is set the moment SAFETY_MODEL's own first attempt
    // failed, even if a fallback then rescued the verdict (see
    // judgeOneLine's own comment) — logged in full here (Vercel function
    // logs), and a capped sample rides in `why` below so ?debug=1 shows it
    // too, without one bad run making `why` enormous. A 429 specifically
    // (real rate limiting, distinct from a timeout) is counted separately
    // so it's visible at a glance whether that's ever actually happening.
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
    (safetyModelsSeen.length ? " · safety model: " + safetyModelsSeen.join("+") + " (" + safetyLatencyTotal + "ms)" : "") +
    (safetyReasons.length ? " · " + safetyReasons.slice(0, 3).join(" | ") + (safetyReasons.length > 3 ? " (+" + (safetyReasons.length - 3) + " more, see logs)" : "") : "");

  let ranked, tasteNote;
  if (taste.ok) {
    ranked = taste.ranked.filter(function (item) { return !flagged.has(item); });
    // Every candidate's computed total, and the gate that killed each
    // eliminated one — exactly what ?debug=1 needs to see the judge's
    // actual reasoning, not just its final picks. A safety-flagged
    // candidate is tagged here too, whatever taste made of it, since
    // that's exactly why it's missing from `ranked` above.
    const totalsNote = taste.details.map(function (d) {
      const flag = flagged.has(d.candidate) ? " [safety-flagged]" : "";
      return "[" + d.lane + "] " + (d.eliminated ? "elim:" + d.killedBy : "total:" + d.total) + flag;
    }).join(", ");
    tasteNote = "taste: " + taste.model + " (" + (taste.latencyMs || 0) + "ms) — " + totalsNote;
  } else {
    // Fallback: fixed lane order, same as v3's original bridge selection —
    // still a reasonable "something is better than nothing" ordering, just
    // not the ranked-by-taste one. Safety-flagged candidates are excluded
    // here too, same as the ranked branch above.
    ranked = allCandidates
      .filter(function (item) { return !flagged.has(item); })
      .sort(function (a, b) { return ALL_LANES.indexOf(a.lane) - ALL_LANES.indexOf(b.lane); });
    tasteNote = "taste: failed open (" + taste.reason + ") — fell back to fixed lane order";
  }
  const top3 = ranked.slice(0, 3);

  const responseStarted = Date.now();
  const drafts = top3.map(function (item) { return { lane: item.lane, text: item.text }; });
  const source = drafts.length ? "model" : "stall";
  if (!drafts.length) drafts.push({ lane: "stall", text: stallLine() });

  stages.t_response = Date.now() - responseStarted;
  const why = "primary A: " + (primaryA.why || "?") + " · primary B: " + (primaryB.why || "?") +
    " · wildcard: " + (wildcard.skip ? "skipped" : (wildcard.why || "?")) +
    " · " + safetyNote + " · " + tasteNote + " · stages: " + formatStages(stages);

  const primaryDebugLines = (primaryA.debugLines || []).concat(primaryB.debugLines || []);
  const primaryTGen = (primaryA.t_gen != null || primaryB.t_gen != null)
    ? Math.max(primaryA.t_gen || 0, primaryB.t_gen || 0)
    : null;

  res.status(200).json({
    sent: sent,
    drafts: drafts,
    source: source,
    why: why || null,
    provider: primaryA.provider || primaryB.provider || null,
    logged: logged,
    debug: {
      primary: primaryDebugLines.length ? primaryDebugLines : null,
      wildcard: wildcard.debugLines || null,
      judge: taste.ok ? taste.details : null
    },
    t_gen: primaryTGen,
    t_judge: stages.t_judge,
    t_total: Date.now() - requestStarted,
    safety: { state: crisisResult.state, source: "classifier" }
  });
};

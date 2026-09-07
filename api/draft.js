// api/draft.js

const { norm } = require("../lib/normalize");
const { callLLM } = require("../lib/llm");
const { ACTIVE_SHAPES, normalizeBefore } = require("../lib/prompt");
const {
  extractArray, extractSingle, normalizeItem, isRefusal, orderByShape, filterLines,
  describeDrops, createDiversityTracker
} = require("../lib/postprocess");
const { judgeOneLine, judgeRelevance } = require("../lib/judge");
const { composeDraft } = require("../lib/compose");
const { stallLine } = require("../lib/fallback");
const { isBlocked } = require("../lib/block");
const { checkCrisis } = require("../lib/crisis");
const { curatedLeadFor } = require("../lib/curated");
const { createLimiter } = require("../lib/rateLimit");
const { maskPII } = require("../lib/mask");
const { waitUntil } = require("@vercel/functions");

// Captured once, the instant this module is first loaded into a container
// (a cold start, or a deploy) — never again after that on a warm container,
// since require() caches the module. t_cold (computed at the top of the
// handler below) is the gap between that moment and this particular
// request's handler actually running: near-zero on a genuine cold start
// (module just finished loading, handler runs right after), and however
// long this container has been sitting warm on every request after that.
// Either way it rules cold start in or out as an explanation for a slow
// request, which nothing else here could tell you.
const MODULE_LOADED_AT = Date.now();

// Per-request timing accumulator, threaded through fromAi -> callOnce
// (mutated in place rather than returned/merged, since callOnce can run
// more than once per request — a same-model retry or a fallback-model
// attempt — and every stage's time across every attempt is what actually
// explains where t_total went, not just the attempt that finally worked).
// t_gen/t_judge (the existing per-response ?debug=1 fields) still only ever
// reflect the FINAL attempt; this is the fuller picture, folded into `why`
// by formatStages below.
function newStages() {
  return {
    t_cold: 0,
    t_parse: 0, // parsing the incoming request body — was named t_body; renamed to make
    // room for the LLM response's OWN t_body below, which is the one that
    // actually matters (see callOnce and lib/llm.js).
    t_block: 0,
    t_prompt: 0,
    // t_ttfb/t_body split what used to be one undifferentiated t_llm number
    // — t_ttfb is time to the response headers, t_body is everything after
    // that until the full response (the model's complete output) is read.
    // For a non-streaming completion, t_body IS the generation wait; t_ttfb
    // alone was silently passing as "the LLM call took Xms" while missing
    // almost all of it. See lib/llm.js's callLLM for where these come from.
    t_ttfb: 0,
    t_body: 0,
    llmAttempts: 0,
    llmRetried: false,
    llmFallback: false,
    t_filter: 0,
    t_order: 0,
    t_judge: 0,
    t_response: 0
  };
}

function formatStages(s) {
  const llmNote = s.llmAttempts + (s.llmRetried ? ", retry" : "") + (s.llmFallback ? ", fallback" : "");
  return "t_cold=" + s.t_cold + "ms t_parse=" + s.t_parse + "ms t_block=" + s.t_block + "ms" +
    " t_prompt=" + s.t_prompt + "ms t_ttfb=" + s.t_ttfb + "ms t_body=" + s.t_body + "ms (" + llmNote + ")" +
    " t_filter=" + s.t_filter + "ms t_order=" + s.t_order + "ms t_judge=" + s.t_judge + "ms" +
    " t_response=" + s.t_response + "ms";
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

// One call to the model. `reason` on an empty result says why, so fromAi
// below can tell "every line got filtered" (worth a retry) apart from
// "no json" / "timed out" / etc. (not worth one — a malformed response
// isn't going to fix itself on a second try the way an unlucky draw of
// filtered lines might).
//
// `genOpts` (see lib/prompt.js's systemPrompt) says what to actually
// generate — {shapes: [lead], count: 1} for the lead request, {shapes:
// ACTIVE_SHAPES minus the lead, count: 4} for the alternates request (see
// the handler below, the only caller). `judgeCount` says how many of the
// kept lines, in display order, actually go to the judge: 1 for the lead
// (there's only ever one to judge), 2 for alternates (the two "another"
// needs) — generating 4 but only judging 2 leaves margin for the keyword
// wall to drop a couple without the whole call coming back empty.
//
// `debugLines` carries filterLines' full `all` array — every line the model
// wrote, shape-tagged, marked kept or dropped and by which filter — through
// to the response for ?debug=1, regardless of whether the call ended up
// usable. Only set when there was something to parse; the empty-output and
// error paths have no lines to show.
//
// `t_gen`/`t_judge` (ms) ride along for ?debug=1 — t_gen from callLLM's own
// latencyMs, t_judge measured around the judge dispatch below. Only set once
// there's something to time; a no-parse/refusal result has no t_judge (never
// reached the judge), and the outer catch has neither. `stages` (see
// newStages above) accumulates the same numbers, plus t_prompt/t_filter/
// t_order, across however many times callOnce runs this request — see
// fromAi below, which is the only caller and always passes one.
async function callOnce(key, model, sent, genOpts, judgeCount, stages) {
  stages = stages || newStages();
  try {
    stages.llmAttempts++;
    const result = await callLLM(key, model, sent, genOpts);
    const t_gen = result.latencyMs;
    stages.t_prompt += result.t_prompt || 0;
    stages.t_ttfb += result.t_ttfb || 0;
    stages.t_body += result.t_body || 0;
    // Tag every why with the upstream provider OpenRouter actually routed
    // to (also returned bare as `provider`, for the ?debug=1 view), so a
    // run of requests shows whether routing moved mid-session. Also
    // console.log'd directly — provider routing (see lib/prompt.js's
    // buildRequest, which now asks OpenRouter to sort by throughput) is
    // exactly the kind of thing worth seeing in the raw function logs
    // without having to go find a specific request's `why`.
    const provider = result.provider || null;
    console.log("provider: " + (provider || "unknown") + " (" + model + ")");
    const providerTag = provider ? " [" + provider + "]" : "";
    // n=1 (the lead request) gets the lenient parser — a model (seen
    // concretely: gpt-5.4, this app's own fallback model) sometimes drops
    // the array wrapper and returns a bare {"shape":...,"text":...} object
    // when it's only been asked for one line. n=4 and the legacy/bake full
    // batch stay strict (extractArray only) — see extractSingle's own
    // comment in lib/postprocess.js for why that's not extended to them.
    const parseFn = (genOpts && genOpts.count === 1) ? extractSingle : extractArray;
    const parsed = parseFn(result.text);
    if (!parsed) {
      const why = result.finishReason === "length" ? "hit token limit" : (result.text ? "no json in output" : "empty output");
      // The raw text is the only way to actually diagnose an unparsable
      // response after the fact — without it, "no json in output" says
      // nothing about what the model actually wrote (an explanation
      // instead of JSON? a differently-shaped object? truncated mid-token?).
      console.error("parse failure (" + why + ") model=" + model + " raw=" + JSON.stringify(String(result.text || "").slice(0, 800)));
      return { lines: [], why: why + providerTag, provider: provider, reason: "unparsable", t_gen: t_gen };
    }
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return { lines: [], skip: true, t_gen: t_gen };
    const filterStarted = Date.now();
    const filtered = filterLines(items, sent);
    stages.t_filter += Date.now() - filterStarted;
    const drops = describeDrops(filtered);
    if (!filtered.kept.length) {
      return { lines: [], why: (drops || "all " + items.length + " filtered") + providerTag, provider: provider, reason: "filtered", debugLines: filtered.all, t_gen: t_gen };
    }

    // Order the survivors — orderByShape's leadPos defaults to 0 now
    // (fixed, no server-side rotation — see its own comment in
    // lib/postprocess.js): which shape actually leads the whole result is
    // decided by the client before this request is even sent (the lead
    // request's own `shapes` is just [thatShape]), so there's no "which
    // shape goes first" question left for THIS ordering to answer — it
    // only has to put the alternates in a stable, sensible order among
    // themselves.
    const orderStarted = Date.now();
    const provisional = orderByShape(filtered.kept);
    stages.t_order += Date.now() - orderStarted;

    // genOpts.exclude (set only on the alternates request — see the
    // handler below) is the lead shape: the prompt already tells the model
    // not to write it, but a model can ignore that. Filtered out here,
    // before backfill even starts, rather than after the fact once
    // candidates are already committed — filtering post-judge would either
    // silently shrink the result below judgeCount with no chance to
    // backfill, or (worse) burn one of the MAX_JUDGE_ATTEMPTS judge calls
    // on a line that was never going to be shown either way.
    const excludeShape = genOpts && genOpts.exclude;
    const eligible = excludeShape
      ? provisional.filter(function (item) { return item.shape !== excludeShape; })
      : provisional;

    // The lead call (genOpts.pickBest — see the handler below, which also
    // sets count: 2) asks the model for 2 candidates of the same shape
    // instead of 1, then picks the better one here — replaces the whole
    // backfill loop below for this call, since there's no "keep judging
    // until enough survive" question when the goal is choosing 1 winner
    // out of exactly 2. Safety-judge both in parallel first (the exact
    // same judgeOneLine call the backfill loop uses); a lone safety
    // survivor wins by default — nothing to compare it against, so no
    // relevance call spent on it. Two survivors go through a second judge
    // question — lib/judge.js's judgeRelevance, the reviewer's "connection
    // test" — as a mechanical gate: does the punchline actually turn on
    // something specific in the sent text, or would it work as a reply to
    // anything? Prefer the YES line; both YES, both NO, or an inconclusive
    // call on either side (judgeRelevance failed, or came back null) falls
    // back to the shorter line — a deterministic tiebreak either way, and
    // "shorter wins" also just tends to read tighter.
    if (genOpts && genOpts.pickBest) {
      const candidates = eligible.slice(0, 2);
      const judgeStarted = Date.now();
      const safetyVerdicts = await Promise.all(candidates.map(function (item) { return judgeOneLine(key, composeDraft(sent, item.text)); }));
      const judgeModelsSeen = [];
      let judgeLatencyTotal = 0;
      let judgeRetries = 0;
      let droppedJudgeCount = 0;
      let judgeFailedCount = 0;
      const verdictByItem = new Map(); // item -> "judge" | "relevance" | null (null = winner)
      const safe = [];
      candidates.forEach(function (item, i) {
        const result = safetyVerdicts[i];
        judgeLatencyTotal += result.latencyMs || 0;
        if (result.retried) judgeRetries++;
        if (result.model && judgeModelsSeen.indexOf(result.model) === -1) judgeModelsSeen.push(result.model);
        if (result.verdict === null) judgeFailedCount++;
        if (result.verdict === true) {
          droppedJudgeCount++;
          verdictByItem.set(item, "judge");
          return;
        }
        safe.push(item);
      });
      const judgeNote = "judge: " + droppedJudgeCount + " dropped" +
        (judgeFailedCount ? " (" + judgeFailedCount + " failed open)" : "") +
        (judgeModelsSeen.length
          ? " · judge model: " + judgeModelsSeen.join("+") + " (" + judgeLatencyTotal + "ms" +
            (judgeRetries ? ", " + judgeRetries + " retried" : "") + ")"
          : "");
      // Same merge pattern as the backfill loop's mergedAll below (an item
      // -> verdict map, walked in lockstep against filtered.all/kept) — see
      // its own comment there for the invariant this relies on.
      function mergeDebug() {
        let ki = 0;
        return filtered.all.map(function (entry) {
          if (entry.dropped) return entry;
          const keptItem = filtered.kept[ki];
          ki++;
          if (!verdictByItem.has(keptItem)) {
            return { shape: entry.shape, text: entry.text, dropped: true, filter: "unjudged" };
          }
          const filter = verdictByItem.get(keptItem);
          return filter === null
            ? { shape: entry.shape, text: entry.text, dropped: false, filter: null }
            : { shape: entry.shape, text: entry.text, dropped: true, filter: filter };
        });
      }

      if (!safe.length) {
        const t_judge = Date.now() - judgeStarted;
        stages.t_judge += t_judge;
        return { lines: [], why: judgeNote + providerTag, provider: provider, reason: "filtered", debugLines: mergeDebug(), t_gen: t_gen, t_judge: t_judge };
      }

      if (safe.length === 1) {
        verdictByItem.set(safe[0], null);
        const t_judge = Date.now() - judgeStarted;
        stages.t_judge += t_judge;
        const why = "ok, kept 1 — only safety survivor, no connection test needed" + providerTag + " · " + judgeNote;
        return { lines: safe, why: why, provider: provider, debugLines: mergeDebug(), t_gen: t_gen, t_judge: t_judge };
      }

      // Both candidates cleared safety — the connection test decides.
      const relVerdicts = await Promise.all(safe.map(function (item) { return judgeRelevance(key, composeDraft(sent, item.text)); }));
      const t_judge = Date.now() - judgeStarted;
      stages.t_judge += t_judge;

      const relA = relVerdicts[0].verdict, relB = relVerdicts[1].verdict;
      let winnerIdx, pickReason;
      if (relA === true && relB !== true) {
        winnerIdx = 0;
        pickReason = "connection test: line 1 YES, line 2 " + (relB === false ? "NO" : "inconclusive");
      } else if (relB === true && relA !== true) {
        winnerIdx = 1;
        pickReason = "connection test: line 2 YES, line 1 " + (relA === false ? "NO" : "inconclusive");
      } else {
        winnerIdx = safe[0].text.length <= safe[1].text.length ? 0 : 1;
        const tieKind = (relA === true && relB === true) ? "both YES" : (relA === false && relB === false) ? "both NO" : "inconclusive";
        pickReason = "connection test tied (" + tieKind + "), shorter line won";
      }
      const winner = safe[winnerIdx];
      const loser = safe[1 - winnerIdx];
      verdictByItem.set(winner, null);
      verdictByItem.set(loser, "relevance");

      const why = "ok, kept 1 — " + pickReason + providerTag + " · " + judgeNote;
      return { lines: [winner], why: why, provider: provider, debugLines: mergeDebug(), t_gen: t_gen, t_judge: t_judge };
    }

    // Backfill, not a fixed top-N: judge lines in display order, in waves,
    // until `judgeCount` survive or MAX_JUDGE_ATTEMPTS is reached —
    // wave 1 judges exactly `judgeCount` lines in parallel (identical cost
    // to the old fixed approach in the common case, where nothing gets
    // flagged); only if that wave comes up short does a follow-up wave
    // judge exactly as many more as still needed, so a flagged line no
    // longer just shrinks the result — the next line in line gets a shot
    // instead. Diversity (opener/prop/simile repeats — see
    // createDiversityTracker in lib/postprocess.js) is checked here too,
    // scoped to actual survivors only: a line judge-flagged or never
    // judged at all no longer "uses up" an opener or a prop for a line
    // that never actually got shown, which is what checking it inside
    // filterLines (its old home) couldn't guarantee.
    const MAX_JUDGE_ATTEMPTS = 4;
    const limit = Math.min(MAX_JUDGE_ATTEMPTS, eligible.length);
    const tracker = createDiversityTracker();
    const survivors = [];
    const verdictByItem = new Map(); // item -> "judge" | "diversity" | null (null = survivor)
    let droppedJudgeCount = 0;
    let droppedDiversityCount = 0;
    let judgeFailedCount = 0;
    let attemptedCount = 0;
    // Which judge model(s) actually answered, and how long — lib/judge.js's
    // judgeOneLine tries JUDGE_MODEL first and only falls back to
    // JUDGE_FALLBACK_MODEL once that attempt fails (timeout/error/
    // unparsable), so seeing the fallback model here at all means a retry
    // happened. Order preserved, no duplicates, so "judge model: a+b" always
    // reads as "started on a, had to fall back to b at some point".
    const judgeModelsSeen = [];
    let judgeLatencyTotal = 0;
    let judgeRetries = 0;
    const judgeStarted = Date.now();
    let nextIndex = 0;
    while (survivors.length < judgeCount && nextIndex < limit) {
      const need = judgeCount - survivors.length;
      const waveEnd = Math.min(limit, nextIndex + need);
      const wave = eligible.slice(nextIndex, waveEnd);
      // The judge sees the full composed exchange (sent + continuation),
      // not the continuation alone — lib/judge.js's own JUDGE_QUESTION now
      // asks it to weigh the reply against what it's actually replying to
      // (composeDraft is the same sent+continuation join renderDraft and
      // buildShareText use elsewhere, so this is exactly what a visitor
      // would read).
      const verdicts = await Promise.all(wave.map(function (item) { return judgeOneLine(key, composeDraft(sent, item.text)); }));
      wave.forEach(function (item, i) {
        attemptedCount++;
        const result = verdicts[i];
        judgeLatencyTotal += result.latencyMs || 0;
        if (result.retried) judgeRetries++;
        if (result.model && judgeModelsSeen.indexOf(result.model) === -1) judgeModelsSeen.push(result.model);
        const verdict = result.verdict;
        if (verdict === null) judgeFailedCount++; // both attempts failed — fail open, treated as OK below
        if (verdict === true) {
          droppedJudgeCount++;
          verdictByItem.set(item, "judge");
          return;
        }
        if (tracker.isDuplicate(item.text)) {
          droppedDiversityCount++;
          verdictByItem.set(item, "diversity");
          return;
        }
        tracker.record(item.text);
        survivors.push(item);
        verdictByItem.set(item, null);
      });
      nextIndex = waveEnd;
    }
    const t_judge = Date.now() - judgeStarted;
    stages.t_judge += t_judge;
    const judgeNote = "judge: " + droppedJudgeCount + " dropped" +
      (judgeFailedCount ? " (" + judgeFailedCount + " failed open)" : "") +
      (droppedDiversityCount ? " · diversity: " + droppedDiversityCount + " dropped" : "") +
      (judgeModelsSeen.length
        ? " · judge model: " + judgeModelsSeen.join("+") + " (" + judgeLatencyTotal + "ms" +
          (judgeRetries ? ", " + judgeRetries + " retried" : "") + ")"
        : "");

    // Merge the verdicts back into the full model-output-order list for
    // ?debug=1: an attempted candidate's entry reflects its verdict (kept,
    // "judge", or "diversity"); a line matching genOpts.exclude is marked
    // "excluded" (the model wrote the lead shape anyway, despite not being
    // asked to); anything else kept but never reached is "unjudged" — the
    // backfill loop found enough survivors first, or hit MAX_JUDGE_ATTEMPTS,
    // before getting to it.
    let ki = 0;
    const mergedAll = filtered.all.map(function (entry) {
      if (entry.dropped) return entry;
      const keptItem = filtered.kept[ki];
      ki++;
      if (excludeShape && keptItem.shape === excludeShape) {
        return { shape: entry.shape, text: entry.text, dropped: true, filter: "excluded" };
      }
      if (!verdictByItem.has(keptItem)) {
        return { shape: entry.shape, text: entry.text, dropped: true, filter: "unjudged" };
      }
      const filter = verdictByItem.get(keptItem);
      return filter === null
        ? { shape: entry.shape, text: entry.text, dropped: false, filter: null }
        : { shape: entry.shape, text: entry.text, dropped: true, filter: filter };
    });

    // Judging (and diversity) clearing nobody is the same situation as the
    // keyword wall doing it above — nothing usable came out of this call —
    // so it gets the same reason: "filtered", which is what earns a retry
    // in fromAi below.
    if (!survivors.length) {
      return { lines: [], why: judgeNote + providerTag, provider: provider, reason: "filtered", debugLines: mergedAll, t_gen: t_gen, t_judge: t_judge };
    }

    // survivors is already in display order — built by walking `provisional`
    // (orderByShape's output) wave by wave, front to back, pushing each one
    // the moment it clears both judge and diversity. No second sort needed.
    const kept = survivors;
    // Drop counts on a success, not just a failure — "ok, kept 2" alone
    // hides that 4 of the 6 got filtered; the breakdown says which rule.
    // "judged N/M" says how many of the keyword-wall survivors actually
    // went to the judge (the backfill loop's real attempt count, not a
    // fixed number) out of how many passed the wall in the first place.
    const why = "ok, kept " + kept.length + (drops ? " — " + drops : "") + providerTag +
      " · judged " + attemptedCount + "/" + filtered.kept.length + " · " + judgeNote;
    // ?debug=1's line list reads in display order — the kept lines first,
    // in the exact order index.html's pool will show them (matching `kept`
    // above), then the dropped ones after, in the order the model
    // originally wrote them (mergedAll's own order, filtered down to just
    // the dropped entries).
    const debugLines = kept
      .map(function (item) { return { shape: item.shape, text: item.text, dropped: false, filter: null }; })
      .concat(mergedAll.filter(function (entry) { return entry.dropped; }));
    return { lines: kept, why: why, provider: provider, debugLines: debugLines, t_gen: t_gen, t_judge: t_judge };
  } catch (err) {
    // callLLM throwing (network/timeout/HTTP) is the only way to land here
    // before stages.t_ttfb/t_body were already credited above — it stamps
    // its own latencyMs/t_ttfb/t_body/t_prompt on the error for exactly
    // this case (see lib/llm.js).
    stages.t_ttfb += (err && err.t_ttfb) || 0;
    stages.t_body += (err && err.t_body) || 0;
    stages.t_prompt += (err && err.t_prompt) || 0;
    return { lines: [], why: /timeout/i.test(err.message) ? "timed out" : err.message, provider: null, reason: "error" };
  }
}

// Appends which model actually produced this result to `why`, so ?debug=1
// (and the Vercel logs) show whether the primary model answered or the
// fallback below had to step in. A skipped (refusal) result has no `why` to
// tag — the endpoint short-circuits on `skip` before `why` is ever shown.
function tagModel(result, model) {
  if (result.why) result.why = result.why + " · model: " + model;
  return result;
}

const FALLBACK_MODEL = "openai/gpt-5.4";

async function fromAi(sent, genOpts, judgeCount, stages) {
  stages = stages || newStages();
  const key = process.env.LLM_API_KEY;
  if (!key) return { lines: [], why: "no api key" };

  const model = process.env.LLM_MODEL || "nousresearch/hermes-4-405b";
  const first = await callOnce(key, model, sent, genOpts, judgeCount, stages);

  // Every line from the first call got filtered — one retry before giving
  // up on the model. Temperature is 1.0, so a second draw is often clean
  // even when the first wasn't; a parse failure or network error doesn't
  // get this second chance (those fall to the fallback model below
  // instead), only a bad-content draw does.
  if (!first.skip && !first.lines.length && first.reason === "filtered") {
    stages.llmRetried = true;
    return tagModel(await callOnce(key, model, sent, genOpts, judgeCount, stages), model);
  }

  // The primary model either refused outright (skip) or failed to produce
  // anything at all — a thrown error, a timeout, or output that didn't
  // parse as JSON. One attempt on a different model before giving up
  // entirely; a content-filtered draw above isn't this path.
  if (first.skip || first.reason === "error" || first.reason === "unparsable") {
    stages.llmFallback = true;
    return tagModel(await callOnce(key, FALLBACK_MODEL, sent, genOpts, judgeCount, stages), FALLBACK_MODEL);
  }

  return tagModel(first, model);
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
// responding — its outcome can no longer ride in the JSON response the way
// it used to (the response is already on its way to the client by the time
// this settles), so "did it work" now lives only in the Vercel function
// logs: every path here logs t_remember (ms) plus, on failure, why. That's
// also how the ~2.8s of "t_total minus t_gen minus t_judge" that prompted
// this change shows up now — check the logs for t_remember on a slow
// request instead of the response body.
async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const started = Date.now();
  try {
    // The unmasked `sent` is never touched here — the LLM call already
    // happened with the real text before remember() runs; this is a
    // storage-only concern (see lib/mask.js).
    const d = dedupeKey(sent);
    // inbox.key is unique — a repeat input used to 409 here, since a plain
    // POST is an insert, not an upsert. on_conflict=key + resolution=merge-
    // duplicates turns this into an upsert: a repeat key updates the
    // existing row (via PostgREST's UPSERT semantics) instead of erroring.
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
// is never retained: remember() now fires in parallel with generation (see
// the handler), so by the time a request turns out to be a refusal, a row
// may already be sitting in `inbox` for it; this purges it regardless of
// whether THIS request is what inserted it (a row from an earlier, non-
// refused submission that normalizes to the same key gets cleaned up too —
// e.g. if BLOCK's own rules ever expand to cover something that wasn't
// blocked when it was first stored).
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
  // See newStages/MODULE_LOADED_AT above for what t_cold actually measures.
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

  // Keep-warm ping (see vercel.json's cron — every 5 minutes) — a GET, not
  // a POST, so it has to be handled before the POST-only check below. No
  // parsing, no model call, no Supabase: the entire point is to keep this
  // function's container warm without doing any real work, so a cold
  // start lands on an actual visitor's request as rarely as possible.
  // Guarded by CRON_SECRET exactly like api/cron/cleanup.js's isAuthorized
  // — Vercel attaches Authorization: Bearer <CRON_SECRET> to its own
  // scheduled invocations once that env var is set on the project, so this
  // rejects anyone else pinging it directly. With no CRON_SECRET configured
  // the guard is skipped (same as cleanup.js — useful for local/dev,
  // set it in production).
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
  // Two-request generation (see lib/prompt.js's systemPrompt and
  // api/draft.js's callOnce for what these actually drive): n=1&lead=<shape>
  // is the lead request — two candidates of exactly that shape, safety- and
  // relevance-judged against each other (callOnce's pickBest branch), one
  // winner returned. n=4&lead=<shape> is the alternates request — four
  // lines across the OTHER active shapes (lead excluded, since the client
  // already has that one from the n=1 call), the first two in display
  // order judged and returned. `lead` is required either way: for n=1 it's
  // what to write, for n=4 it's what to exclude. Which shape leads at all
  // is a client-side decision now (the device's own rotation — see
  // index.html) — the server no longer tracks or rotates a "current lead
  // shape" itself.
  const n = Number(body.n);
  const lead = String(body.lead || "").trim().toLowerCase();
  stages.t_parse = Date.now() - parseStarted;
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }
  if (n !== 1 && n !== 4) { res.status(400).json({ error: "n must be 1 or 4" }); return; }
  if (ACTIVE_SHAPES.indexOf(lead) === -1) { res.status(400).json({ error: "lead must be a valid shape" }); return; }

  const blockStarted = Date.now();
  const blocked = isBlocked(sent);
  stages.t_block = Date.now() - blockStarted;
  // waitUntil (from @vercel/functions) keeps this invocation alive for the
  // given promise without making the client's response wait on it — the
  // opposite of `await`. Nothing here reads forget()'s result, so there's
  // nothing to gate the response on in the first place.
  if (blocked) { waitUntil(forget(sent)); res.status(200).json({ refuse: true, drafts: [] }); return; }

  // t_total (ms) covers from here — the point past the cheap synchronous
  // checks above — to just before responding, so it reflects "how long did
  // generation + judging actually take" now that storage no longer gates
  // the response at all (see below) — this is what used to leave ~2.8s of
  // t_total unaccounted for by t_gen+t_judge; that gap was remember()
  // running serially in the response path. It's still fired here, in
  // parallel with generation rather than after it, since it only needs
  // `sent` — waitUntil just means it no longer has to finish before either.
  const requestStarted = Date.now();
  const rememberPromise = remember(sent);
  waitUntil(rememberPromise);

  // `logged` used to be remember()'s own awaited result ("ok" / a status
  // code / "error") — it can't be anymore now that remember() runs via
  // waitUntil, unawaited, after this response is already on its way out.
  // "deferred" just means Supabase is configured and the write was fired;
  // whether it actually landed is in the function logs (t_remember, and
  // any "supabase inbox insert failed/threw" line) now, not here. null
  // still means what it always did: no Supabase config, nothing fired.
  // Computed here (rather than down by the model response) so the curated
  // short-circuit right below can report it too.
  const logged = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) ? "deferred" : null;

  // Curated leads (lib/curated.js) — a tiny hand-picked bank for exactly
  // the four featured example chips (see index.html's #chips), matched on
  // normalizeBefore(sent) (lib/prompt.js — lowercase, trailing punctuation
  // stripped). Those four inputs are the app's whole demo: a weak or
  // random model draw for one of them is the worst possible first
  // impression, so a match skips generation, the crisis check, and the
  // judge entirely and returns one of the pre-vetted lines instead. Lead
  // (n=1) only — alternates (n=4) always come from the model, even for a
  // curated sent text, so "another" never shows the same fixed handful.
  // remember() above still fires for a curated match (this text was still
  // submitted, same retention policy applies), but nothing else in the
  // usual pipeline runs.
  if (n === 1) {
    const curated = curatedLeadFor(normalizeBefore(sent));
    if (curated) {
      res.status(200).json({
        sent: sent,
        drafts: [{ shape: curated.shape, text: curated.text }],
        source: "curated",
        why: "curated",
        provider: null,
        logged: logged,
        debug: null,
        t_gen: null,
        t_judge: null,
        t_total: Date.now() - requestStarted
      });
      return;
    }
  }

  // Crisis pre-check (lib/crisis.js) — a second, semantic layer past
  // isBlocked() above, for ambiguous phrasing ("i don't want to be here
  // anymore") that keyword matching structurally can't catch. Only fired
  // for the lead request: index.html never fires the alternates (n=4) call
  // at all once a lead response comes back flagged (same as it already
  // skips alternates on a plain refusal), so checking there too would just
  // be a second call for the same verdict. Fired here, in parallel with
  // generation, specifically so it costs nothing on the common path — by
  // the time generation finishes, this small classification call has
  // almost always already resolved.
  const crisisPromise = n === 1 ? checkCrisis(process.env.LLM_API_KEY, sent) : Promise.resolve(false);

  // n=1: write 2 candidates of exactly the lead shape — pickBest (see
  // callOnce) safety-judges both and picks the one that actually engages
  // with the sent text, rather than generating (and judging) just one with
  // nothing to compare it against. n=4: write everything else — the client
  // already has (or is getting) the lead shape from its own n=1 call, so
  // asking for it again here would just be a duplicate the model could
  // write instead of a genuinely different alternate. `exclude` is
  // callOnce's own defensive backstop for when the model ignores that
  // anyway (see its own comment there) — not read by buildRequest/
  // systemPrompt, only by callOnce's backfill loop.
  const genOpts = n === 1
    ? { shapes: [lead], count: 2, pickBest: true }
    : { shapes: ACTIVE_SHAPES.filter(function (s) { return s !== lead; }), count: 4, exclude: lead };
  // Only read by the n=4 backfill loop now — pickBest (n=1) always judges
  // both candidates regardless of this number and returns exactly 1, so it
  // ignores judgeCount entirely. 2 for alternates — exactly what "make it
  // worse" needs per fetch (see index.html) — generated as 4 so the
  // keyword wall dropping a couple doesn't come back empty.
  const judgeCount = n === 1 ? 1 : 2;

  const ai = await fromAi(sent, genOpts, judgeCount, stages);

  // Checked ahead of ai.skip below — a crisis verdict wins regardless of
  // what the model itself did with the line, and it's a more specific,
  // more useful response than a generic refusal. crisisPromise (fired
  // above, in parallel with fromAi) has almost always already settled by
  // now, so this rarely adds any real wait.
  const crisis = await crisisPromise;
  if (crisis) {
    waitUntil(rememberPromise.then(function () { return forget(sent); }));
    res.status(200).json({ crisis: true, drafts: [] });
    return;
  }

  // A model skip is a refusal, full stop — never paper over it with the
  // fallback lines below. forget() has to run after remember() actually
  // lands (not race it) or the delete could fire before the insert does and
  // leave the row behind — chained onto rememberPromise and handed to
  // waitUntil as one unit so Vercel keeps the invocation alive for both, in
  // order, without the response waiting on either.
  if (ai.skip) {
    waitUntil(rememberPromise.then(function () { return forget(sent); }));
    res.status(200).json({ refuse: true, drafts: [] });
    return;
  }

  const responseStarted = Date.now();
  // Each draft carries its shape along ({shape, text}) — the client needs
  // it to log which shape a reaction tap (see index.html's #react buttons)
  // was against. A stall line isn't one of the model's shapes, so it's
  // tagged with the source it came from instead.
  const drafts = [];
  // ai.lines is already in display order — fixed by shape, not by how
  // strong the model thought each line was (see postprocess.js's
  // orderByShape) — so the client just shows them in the order given.
  //
  // The `typeof text === "string"` guard is belt-and-suspenders on top of
  // postprocess.js's own normalizeItem/normalizeText (which is where a
  // non-string text field actually gets neutralized) — a draft only ever
  // leaves this endpoint carrying real string text, never something that
  // could render as "[object Object]" downstream.
  ai.lines.forEach(function (item) {
    const text = item && item.text;
    if (typeof text !== "string" || !text) return;
    // A line matching the lead shape (n=4's genOpts.exclude) can't reach
    // here — callOnce's backfill loop filters those out before judging, so
    // a flagged one gets backfilled from an actual alternate instead of
    // just silently shrinking the result. See callOnce's own comment.
    const dupe = drafts.some(function (d) { return d.text === text; });
    if (!dupe) drafts.push({ shape: (item && item.shape) || "unknown", text: text });
  });

  // `source` tells you which path produced what you are reading:
  //   model — the model wrote it (what you want)
  //   stall — n=1 only: the lead produced nothing usable even after the
  //           retry in fromAi, so a canned fallback line fills the slot
  //           that's never allowed to come back empty. `why` says what
  //           went wrong.
  //   empty — n=4 only: the alternates call came back with nothing
  //           judge-clean. Not padded with a stall line — the client just
  //           leaves "another" disabled for this result, since these were
  //           always a bonus, not a required slot the way the lead is.
  let source;
  if (drafts.length) {
    source = "model";
  } else if (n === 1) {
    drafts.push({ shape: "stall", text: stallLine() });
    source = "stall";
  } else {
    source = "empty";
  }

  // `logged` is computed earlier now — see the curated-lead short-circuit
  // above, which needs it too.

  stages.t_response = Date.now() - responseStarted;
  // Every stage timer this request touched, folded into `why` — see
  // newStages/formatStages above. ai.why already carries the drop/judge
  // breakdown for the winning attempt; this appends the full per-stage
  // accounting across every attempt (a same-model retry or a fallback-model
  // attempt each add their own t_ttfb/t_body/t_filter/t_order/t_judge on top).
  const why = (ai.why ? ai.why + " · " : "") + "stages: " + formatStages(stages);

  res.status(200).json({
    sent: sent,
    // No cap needed here anymore — drafts is naturally at most 1 (n=1) or
    // 2 (n=4, judgeCount) long, never the old up-to-6.
    drafts: drafts,
    source: source,
    why: why || null,
    provider: ai.provider || null,
    logged: logged,
    // Every line the model wrote this call — shape-tagged, kept/dropped and
    // by which filter — for the ?debug=1 view. null when there was nothing
    // to parse (empty output, timeout, stall-only responses).
    debug: ai.debugLines || null,
    // Timing (ms), for ?debug=1. t_gen/t_judge come from whichever call in
    // fromAi actually produced this result (null if it never got that far —
    // no api key, or an outright error/refusal with nothing to time).
    // t_total is this handler's own wall clock, generation+judging only —
    // storage no longer rides in it (see `logged` above and remember()'s
    // own t_remember log line for that).
    t_gen: ai.t_gen != null ? ai.t_gen : null,
    t_judge: ai.t_judge != null ? ai.t_judge : null,
    t_total: Date.now() - requestStarted
  });
};

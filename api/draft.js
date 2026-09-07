// api/draft.js

const { norm } = require("../lib/normalize");
const { callLLM } = require("../lib/llm");
const { extractArray, normalizeItem, isRefusal, orderByShape, filterLines, describeDrops } = require("../lib/postprocess");
const { judgeLines, applyJudgeVerdict } = require("../lib/judge");
const { stallLine } = require("../lib/fallback");
const { isBlocked } = require("../lib/block");
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
// six filtered lines might).
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
async function callOnce(key, model, sent, stages) {
  stages = stages || newStages();
  try {
    stages.llmAttempts++;
    const result = await callLLM(key, model, sent);
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
    const parsed = extractArray(result.text);
    if (!parsed) {
      const why = result.finishReason === "length" ? "hit token limit" : (result.text ? "no json in output" : "empty output");
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

    // Judge only the first three lines in DISPLAY order — the lead plus two
    // "another" spares — not every line the keyword wall let through.
    // index.html only ever shows 3 (MAX_REVEALS=2 past the lead), so judging
    // a 4th, 5th, 6th line spent a judge call, latency, and cost on lines
    // nobody would see. orderByShape moves here (was after judging) — it
    // only runs once per request either way; dropping judge-flagged
    // candidates below is a plain filter that preserves relative order, so
    // there's nothing left to re-sort afterward.
    const orderStarted = Date.now();
    const provisional = orderByShape(filtered.kept);
    stages.t_order += Date.now() - orderStarted;
    const candidates = provisional.slice(0, 3);

    // lib/judge.js's applyJudgeVerdict expects its `kept`/`all` pair in
    // lockstep (Nth non-dropped `all` entry is `kept[N-1]`) — build a small
    // `all`-shaped array scoped to just `candidates` rather than reusing
    // filtered.all (which still has the other, un-judged kept lines mixed
    // in and would break that invariant).
    const candidateAll = candidates.map(function (c) { return { shape: c.shape, text: c.text, dropped: false, filter: null }; });
    const judgeStarted = Date.now();
    const judgeResult = await judgeLines(key, candidates.map(function (c) { return c.text; }));
    const t_judge = Date.now() - judgeStarted;
    stages.t_judge += t_judge;
    const judged = applyJudgeVerdict(candidates, candidateAll, judgeResult.flagged);
    const judgeNote = "judge: " + judged.droppedJudge + " dropped" +
      (judgeResult.failedCount ? " (" + judgeResult.failedCount + " failed open)" : "");

    // Merge the verdict back into the full model-output-order list for
    // ?debug=1: a candidate's entry reflects the verdict (kept, or dropped
    // "judge"); a kept line that was never a candidate (only possible when
    // more than 3 lines passed the keyword wall) is marked "unjudged" — the
    // model wrote it, it just wasn't in the fastest 3, so it never went to
    // the judge at all.
    let ki = 0;
    const mergedAll = filtered.all.map(function (entry) {
      if (entry.dropped) return entry;
      const keptItem = filtered.kept[ki];
      ki++;
      const pos = candidates.indexOf(keptItem);
      return pos === -1
        ? { shape: entry.shape, text: entry.text, dropped: true, filter: "unjudged" }
        : candidateAll[pos];
    });

    // The judge flagging every candidate is the same situation as the
    // keyword wall doing it above — nothing usable came out of this call —
    // so it gets the same reason: "filtered", which is what earns a retry
    // in fromAi below.
    if (!judged.kept.length) {
      return { lines: [], why: judgeNote + providerTag, provider: provider, reason: "filtered", debugLines: mergedAll, t_gen: t_gen, t_judge: t_judge };
    }

    // judged.kept is already a strict, order-preserving subsequence of
    // candidates (applyJudgeVerdict only filters, never reorders) —
    // candidates was already in display order (orderByShape, above), so
    // this is the final display order too. No second sort needed.
    const kept = judged.kept;
    // Drop counts on a success, not just a failure — "ok, kept 2" alone
    // hides that 4 of the 6 got filtered; the breakdown says which rule.
    // "judged N/M" says how many of the keyword-wall survivors actually
    // went to the judge — M can be bigger than N (candidates.length) when
    // more than 3 lines passed the wall.
    const why = "ok, kept " + kept.length + (drops ? " — " + drops : "") + providerTag +
      " · judged " + candidates.length + "/" + filtered.kept.length + " · " + judgeNote;
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

async function fromAi(sent, stages) {
  stages = stages || newStages();
  const key = process.env.LLM_API_KEY;
  if (!key) return { lines: [], why: "no api key" };

  const model = process.env.LLM_MODEL || "nousresearch/hermes-4-405b";
  const first = await callOnce(key, model, sent, stages);

  // Every line from the first call got filtered — one retry before giving
  // up on the model. Temperature is 1.0, so a second draw is often clean
  // even when the first wasn't; a parse failure or network error doesn't
  // get this second chance (those fall to the fallback model below
  // instead), only a bad-content draw does.
  if (!first.skip && !first.lines.length && first.reason === "filtered") {
    stages.llmRetried = true;
    return tagModel(await callOnce(key, model, sent, stages), model);
  }

  // The primary model either refused outright (skip) or failed to produce
  // anything at all — a thrown error, a timeout, or output that didn't
  // parse as JSON. One attempt on a different model before giving up
  // entirely; a content-filtered draw above isn't this path.
  if (first.skip || first.reason === "error" || first.reason === "unparsable") {
    stages.llmFallback = true;
    return tagModel(await callOnce(key, FALLBACK_MODEL, sent, stages), FALLBACK_MODEL);
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
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) { res.status(429).json({ error: "slow down" }); return; }

  const parseStarted = Date.now();
  const body = readBody(req);
  const sent = String(body.sent || "").trim().slice(0, 500);
  stages.t_parse = Date.now() - parseStarted;
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }

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

  const ai = await fromAi(sent, stages);
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
    const dupe = drafts.some(function (d) { return d.text === text; });
    if (!dupe) drafts.push({ shape: (item && item.shape) || "unknown", text: text });
  });

  // `source` tells you which path produced what you are reading:
  //   model — the model wrote it (what you want)
  //   stall — the model produced nothing usable even after the retry in
  //           fromAi, `why` says what went wrong
  let source = ai.lines.length ? "model" : "stall";
  if (!drafts.length) {
    drafts.push({ shape: "stall", text: stallLine() });
    source = "stall";
  }

  // `logged` used to be remember()'s own awaited result ("ok" / a status
  // code / "error") — it can't be anymore now that remember() runs via
  // waitUntil, unawaited, after this response is already on its way out.
  // "deferred" just means Supabase is configured and the write was fired;
  // whether it actually landed is in the function logs (t_remember, and
  // any "supabase inbox insert failed/threw" line) now, not here. null
  // still means what it always did: no Supabase config, nothing fired.
  const logged = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) ? "deferred" : null;

  stages.t_response = Date.now() - responseStarted;
  // Every stage timer this request touched, folded into `why` — see
  // newStages/formatStages above. ai.why already carries the drop/judge
  // breakdown for the winning attempt; this appends the full per-stage
  // accounting across every attempt (a same-model retry or a fallback-model
  // attempt each add their own t_ttfb/t_body/t_filter/t_order/t_judge on top).
  const why = (ai.why ? ai.why + " · " : "") + "stages: " + formatStages(stages);

  res.status(200).json({
    sent: sent,
    drafts: drafts.slice(0, 6),
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

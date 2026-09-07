// api/draft.js

const { norm } = require("../lib/normalize");
const { callLLM } = require("../lib/llm");
const { extractArray, normalizeItem, isRefusal, orderByShape, filterLines, describeDrops } = require("../lib/postprocess");
const { judgeLines, applyJudgeVerdict } = require("../lib/judge");
const { stallLine } = require("../lib/fallback");
const { isBlocked } = require("../lib/block");
const { createLimiter } = require("../lib/rateLimit");

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
// reached the judge), and the outer catch has neither.
async function callOnce(key, model, sent) {
  try {
    const result = await callLLM(key, model, sent);
    const t_gen = result.latencyMs;
    // Tag every why with the upstream provider OpenRouter actually routed
    // to (also returned bare as `provider`, for the ?debug=1 view), so a
    // run of requests shows whether routing moved mid-session.
    const provider = result.provider || null;
    const providerTag = provider ? " [" + provider + "]" : "";
    const parsed = extractArray(result.text);
    if (!parsed) {
      const why = result.finishReason === "length" ? "hit token limit" : (result.text ? "no json in output" : "empty output");
      return { lines: [], why: why + providerTag, provider: provider, reason: "unparsable", t_gen: t_gen };
    }
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return { lines: [], skip: true, t_gen: t_gen };
    const filtered = filterLines(items, sent);
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
    const provisional = orderByShape(filtered.kept);
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

async function fromAi(sent) {
  const key = process.env.LLM_API_KEY;
  if (!key) return { lines: [], why: "no api key" };

  const model = process.env.LLM_MODEL || "nousresearch/hermes-4-405b";
  const first = await callOnce(key, model, sent);

  // Every line from the first call got filtered — one retry before giving
  // up on the model. Temperature is 1.0, so a second draw is often clean
  // even when the first wasn't; a parse failure or network error doesn't
  // get this second chance (those fall to the fallback model below
  // instead), only a bad-content draw does.
  if (!first.skip && !first.lines.length && first.reason === "filtered") {
    return tagModel(await callOnce(key, model, sent), model);
  }

  // The primary model either refused outright (skip) or failed to produce
  // anything at all — a thrown error, a timeout, or output that didn't
  // parse as JSON. One attempt on a different model before giving up
  // entirely; a content-filtered draw above isn't this path.
  if (first.skip || first.reason === "error" || first.reason === "unparsable") {
    return tagModel(await callOnce(key, FALLBACK_MODEL, sent), FALLBACK_MODEL);
  }

  return tagModel(first, model);
}

const limited = createLimiter();

// Returns what actually happened so the caller can surface it (`logged` in
// the response, visible in ?debug=1) — this used to swallow every outcome,
// success or failure alike, which is how `inbox` went silently empty since
// launch without anything showing it. null = never attempted (no config
// set); "ok" = 2xx; the status code as a string = a non-2xx response,
// also console.error'd with the body so it's in the Vercel function logs;
// "error" = the fetch itself threw (network/DNS/timeout).
async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
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
      body: JSON.stringify({ key: norm(sent) || sent.trim(), sent: sent.trim().slice(0, 500) })
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
  }
}

const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];

module.exports = async function handler(req, res) {
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

  const body = readBody(req);
  const sent = String(body.sent || "").trim().slice(0, 500);
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }
  if (isBlocked(sent)) { res.status(200).json({ refuse: true, drafts: [] }); return; }

  // t_total (ms) covers from here — the point past the cheap synchronous
  // checks above — to just before responding, so it reflects "how long did
  // generation + storage actually take," not raw HTTP/rate-limit overhead.
  //
  // remember() only needs `sent`, not anything fromAi produces, so it fires
  // here rather than after — it used to run serially after the whole AI
  // round trip, adding its own latency on top for no reason. One behavior
  // change worth knowing: it used to never run at all when the model itself
  // refused (ai.skip below) — now that call already fired by the time skip
  // is known, so a model refusal's input gets stored (masked, same as any
  // other) where it didn't before.
  const requestStarted = Date.now();
  const rememberPromise = remember(sent);

  const ai = await fromAi(sent);
  // A model skip is a refusal, full stop — never paper over it with the
  // fallback lines below.
  if (ai.skip) { await rememberPromise; res.status(200).json({ refuse: true, drafts: [] }); return; }

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

  const logged = await rememberPromise;

  res.status(200).json({
    sent: sent,
    drafts: drafts.slice(0, 6),
    source: source,
    why: ai.why || null,
    provider: ai.provider || null,
    logged: logged,
    // Every line the model wrote this call — shape-tagged, kept/dropped and
    // by which filter — for the ?debug=1 view. null when there was nothing
    // to parse (empty output, timeout, stall-only responses).
    debug: ai.debugLines || null,
    // Timing (ms), for ?debug=1. t_gen/t_judge come from whichever call in
    // fromAi actually produced this result (null if it never got that far —
    // no api key, or an outright error/refusal with nothing to time).
    // t_total is this handler's own wall clock, generation+judging+storage.
    t_gen: ai.t_gen != null ? ai.t_gen : null,
    t_judge: ai.t_judge != null ? ai.t_judge : null,
    t_total: Date.now() - requestStarted
  });
};

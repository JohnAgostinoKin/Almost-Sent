// api/draft.js

const { norm } = require("../lib/normalize");
const { exactMatch } = require("../lib/bank");
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
async function callOnce(key, model, sent) {
  try {
    const result = await callLLM(key, model, sent);
    // Tag every why with the upstream provider OpenRouter actually routed
    // to (also returned bare as `provider`, for the ?debug=1 view), so a
    // run of requests shows whether routing moved mid-session.
    const provider = result.provider || null;
    const providerTag = provider ? " [" + provider + "]" : "";
    const parsed = extractArray(result.text);
    if (!parsed) {
      const why = result.finishReason === "length" ? "hit token limit" : (result.text ? "no json in output" : "empty output");
      return { lines: [], why: why + providerTag, provider: provider, reason: "unparsable" };
    }
    const items = parsed.map(normalizeItem);
    if (isRefusal(items)) return { lines: [], skip: true };
    const filtered = filterLines(items, sent);
    const drops = describeDrops(filtered);
    if (!filtered.kept.length) {
      return { lines: [], why: (drops || "all " + items.length + " filtered") + providerTag, provider: provider, reason: "filtered", debugLines: filtered.all };
    }

    // Judge pass: everything the keyword wall didn't already remove (see
    // lib/postprocess.js — it's down to slurs and minor-related terms now)
    // goes to lib/judge.js as one small-model call reviewing all the
    // surviving lines together. A judge failure (timeout/network/unparsable
    // — never thrown, judgeLines always resolves) falls back to the
    // keyword-filtered set exactly as-is; nothing further gets dropped.
    const numbers = await judgeLines(key, filtered.kept.map(function (item) { return item.text; }));
    const judged = applyJudgeVerdict(filtered.kept, filtered.all, numbers);
    const judgeNote = judged.judgeFailed ? "judge: failed, kept keyword-filtered" : "judge: " + judged.droppedJudge + " dropped";

    // The judge flagging every surviving line is the same situation as the
    // keyword wall doing it above — nothing usable came out of this call —
    // so it gets the same reason: "filtered", which is what earns a retry
    // in fromAi below.
    if (!judged.kept.length) {
      return { lines: [], why: judgeNote + providerTag, provider: provider, reason: "filtered", debugLines: judged.all };
    }

    // Display order is fixed by shape, not by how strong the model thought
    // each line was (see orderByShape) — the model no longer ranks these.
    const kept = orderByShape(judged.kept).slice(0, 6);
    // Drop counts on a success, not just a failure — "ok, kept 2" alone
    // hides that 4 of the 6 got filtered; the breakdown says which rule.
    const why = "ok, kept " + kept.length + (drops ? " — " + drops : "") + providerTag + " · " + judgeNote;
    // ?debug=1's line list reads in display order — the kept lines first,
    // in the exact order index.html's pool will show them (matching
    // `kept` above), then the dropped ones after, in the order the model
    // originally wrote them (judged.all's own order, filtered down to just
    // the dropped entries).
    const debugLines = kept
      .map(function (item) { return { shape: item.shape, text: item.text, dropped: false, filter: null }; })
      .concat(judged.all.filter(function (entry) { return entry.dropped; }));
    return { lines: kept, why: why, provider: provider, debugLines: debugLines };
  } catch (err) {
    return { lines: [], why: /timeout/i.test(err.message) ? "timed out" : err.message, provider: null, reason: "error" };
  }
}

async function fromAi(sent) {
  const key = process.env.LLM_API_KEY;
  if (!key) return { lines: [], why: "no api key" };

  const model = process.env.LLM_MODEL || "mistralai/mistral-large-2512";
  const first = await callOnce(key, model, sent);
  if (first.skip || first.lines.length || first.reason !== "filtered") return first;

  // Every line from the first call got filtered — one retry before giving
  // up on the model. Temperature is 1.0, so a second draw is often clean
  // even when the first wasn't; a parse failure or network error doesn't
  // get this second chance, only a bad-content draw does.
  return await callOnce(key, model, sent);
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
    const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/inbox", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
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

  const ai = await fromAi(sent);
  // A model skip is a refusal, full stop — never paper over it with the bank
  // or the fallback lines below.
  if (ai.skip) { res.status(200).json({ refuse: true, drafts: [] }); return; }

  // Each draft carries its shape along ({shape, text}) — the client needs
  // it to log which shape a reaction tap (see index.html's #react buttons)
  // was against. Bank and stall lines aren't one of the model's four
  // shapes, so they're tagged with the source they came from instead.
  const drafts = [];
  const bank = exactMatch(sent);
  if (bank) drafts.push({ shape: "bank", text: bank });
  // ai.lines is already in display order — fixed by shape, not by how
  // strong the model thought each line was (see postprocess.js's
  // orderByShape) — so the client just shows them in the order given. A
  // hero-bank hit is the one exception — it always leads.
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
  //   bank  — a curated line matched exactly
  //   stall — the model produced nothing usable even after the retry in
  //           fromAi, `why` says what went wrong
  let source = ai.lines.length ? (bank ? "bank+model" : "model") : (bank ? "bank" : "stall");
  if (!drafts.length) {
    drafts.push({ shape: "stall", text: stallLine() });
    source = "stall";
  }

  const logged = await remember(sent);

  res.status(200).json({
    sent: sent,
    drafts: drafts.slice(0, 6),
    source: source,
    why: ai.why || null,
    provider: ai.provider || null,
    logged: logged,
    // Every line the model wrote this call — shape-tagged, kept/dropped and
    // by which filter — for the ?debug=1 view. null when there was nothing
    // to parse (empty output, timeout, bank/stall-only responses).
    debug: ai.debugLines || null
  });
};

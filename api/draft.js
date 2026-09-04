// api/draft.js

const { norm } = require("../lib/normalize");
const { exactMatch } = require("../lib/bank");
const { callLLM } = require("../lib/llm");
const { extractArray, isRefusal, filterLines, describeDrops } = require("../lib/postprocess");
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
    if (isRefusal(parsed)) return { lines: [], skip: true };
    const filtered = filterLines(parsed, sent);
    if (!filtered.kept.length) {
      const drops = describeDrops(filtered) || "all " + parsed.length + " filtered";
      return { lines: [], why: drops + providerTag, provider: provider, reason: "filtered" };
    }
    return { lines: filtered.kept.slice(0, 6), why: "ok" + providerTag, provider: provider };
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

async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url + "/rest/v1/inbox", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ key: norm(sent) || sent.trim(), sent: sent.trim().slice(0, 500) })
    });
  } catch (err) {}
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

  const drafts = [];
  const bank = exactMatch(sent);
  if (bank) drafts.push(bank);
  // The model returns its six lines strongest-first (see prompt.js); keep
  // that order so the client can show the best one and reveal the rest in
  // descending order. A hero-bank hit is the one exception — it always leads.
  ai.lines.forEach(function (line) {
    if (drafts.indexOf(line) === -1) drafts.push(line);
  });

  // `source` tells you which path produced what you are reading:
  //   model — the model wrote it (what you want)
  //   bank  — a curated line matched exactly
  //   stall — the model produced nothing usable even after the retry in
  //           fromAi, `why` says what went wrong
  let source = ai.lines.length ? (bank ? "bank+model" : "model") : (bank ? "bank" : "stall");
  if (!drafts.length) {
    drafts.push(stallLine());
    source = "stall";
  }

  await remember(sent);

  res.status(200).json({
    sent: sent,
    drafts: drafts.slice(0, 6),
    source: source,
    why: ai.why || null,
    provider: ai.provider || null
  });
};

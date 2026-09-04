// api/draft.js

const { norm } = require("../lib/normalize");
const { exactMatch } = require("../lib/bank");
const { callLLM } = require("../lib/llm");
const { extractArray, isRefusal, filterLines } = require("../lib/postprocess");
const { keywordFallback, wordFallback } = require("../lib/fallback");
const { isBlocked } = require("../lib/block");

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

async function fromAi(sent) {
  const key = process.env.LLM_API_KEY;
  if (!key) return { lines: [], why: "no api key" };

  const model = process.env.LLM_MODEL || "mistralai/mistral-large-2512";
  try {
    const result = await callLLM(key, model, sent);
    const parsed = extractArray(result.text);
    if (!parsed) {
      if (result.finishReason === "length") return { lines: [], why: "hit token limit" };
      return { lines: [], why: result.text ? "no json in output" : "empty output" };
    }
    if (isRefusal(parsed)) return { lines: [], skip: true };
    const { kept } = filterLines(parsed);
    if (!kept.length) return { lines: [], why: "all " + parsed.length + " filtered (length or content)" };
    return { lines: kept.slice(0, 6) };
  } catch (err) {
    return { lines: [], why: /timeout/i.test(err.message) ? "timed out" : err.message };
  }
}

// Per-instance only. Stops casual hammering, not a determined one — a real limit
// needs shared state (Upstash or a Supabase table).
const HITS = new Map();
function limited(ip) {
  const now = Date.now();
  const row = HITS.get(ip) || { n: 0, start: now };
  if (now - row.start > 60000) { row.n = 0; row.start = now; }
  row.n += 1;
  HITS.set(ip, row);
  if (HITS.size > 5000) HITS.clear();
  return row.n > 20;
}

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
  //   model    — the model wrote it (what you want)
  //   bank     — a curated line matched exactly
  //   fallback — the model produced nothing usable, `why` says what went wrong
  let source = ai.lines.length ? (bank ? "bank+model" : "model") : (bank ? "bank" : "fallback");
  if (!drafts.length) {
    drafts.push(keywordFallback(sent) || wordFallback(sent));
    source = "fallback";
  }

  await remember(sent);

  res.status(200).json({
    sent: sent,
    drafts: drafts.slice(0, 6),
    source: source,
    why: ai.why || null
  });
};

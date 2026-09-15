// api/entries.js
//
// Contest submissions — "didn't laugh? make it funnier" (see index.html's
// #contest). Stores the sent text, the visitor's own line, and (both
// optional) their email and a "show on the wall" opt-in, in a new
// `entries` table (see scripts/entries-schema.sql) — NOT the same as
// `inbox` (the ordinary draft pipeline) or `events` (anonymous
// interaction logs): a contest entry is real content someone
// deliberately submitted to be read, judged, and possibly shown publicly
// (see /wall) or paid a prize for (see /rules), so it's retained past
// the 30-day inbox window and isn't anonymous — see privacy.html's own
// disclosure.
//
// The line is run through lib/judge.js's safety judge (the same one
// production drafts get, judging the FULL composed exchange) before
// anything is stored — a flagged line is refused outright, never
// reaching the table at all, let alone the wall or /admin/entries'
// review queue. Everything else about moderation (actually approving a
// line for the wall, picking a winner) is manual, via /admin/entries —
// this endpoint only ever writes approved:false.
const { composeDraft } = require("../lib/compose");
const { judgeOneLine } = require("../lib/judge");
const { maskPII } = require("../lib/mask");
const { createLimiter } = require("../lib/rateLimit");

const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];
const limited = createLimiter();

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

async function insertEntry(row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, reason: "not configured" };
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/entries", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      console.error("supabase entries insert failed: " + res.status + " " + body.slice(0, 500));
      return { ok: false, reason: "insert failed" };
    }
    return { ok: true };
  } catch (err) {
    console.error("supabase entries insert threw: " + (err && err.message));
    return { ok: false, reason: "error" };
  }
}

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
  const line = String(body.text || "").trim().slice(0, 180);
  const email = String(body.email || "").trim().slice(0, 200);
  const wallOk = body.wall_ok === true;
  const deviceId = String(body.device_id || "").trim().slice(0, 100);

  if (!sent || !line) { res.status(400).json({ ok: false, error: "missing sent or text" }); return; }

  // Safety judge — same call production drafts get (lib/judge.js's
  // judgeOneLine), on the full composed exchange. Only a real FLAG
  // verdict blocks storage; a failed/timed-out judge call (verdict:
  // null) fails open, same convention judgeOneLine's every other caller
  // follows — a bad line still has to clear manual review at
  // /admin/entries before it's ever shown to anyone, so failing open
  // here costs nothing but a slightly noisier review queue. No
  // LLM_API_KEY configured skips the check entirely, same fail-open
  // reasoning — manual review is still the real gate either way.
  const key = process.env.LLM_API_KEY;
  if (key) {
    const composed = composeDraft(sent, line);
    const verdict = await judgeOneLine(key, composed);
    if (verdict.verdict === true) {
      res.status(200).json({ ok: false, error: "flagged" });
      return;
    }
  }

  // Masked the same way inbox.sent already is (lib/mask.js) — a contest
  // line can end up on a PUBLIC wall page, so the text someone pasted in
  // (which might carry a phone number or email of its own) gets the same
  // scrub the ordinary draft pipeline already applies. The line itself
  // (their own writing) isn't masked — it's the whole point of the
  // submission, and the entrant wrote it themselves.
  const maskedSent = maskPII(sent);

  const result = await insertEntry({
    sent: maskedSent,
    text: line,
    email: email || null,
    device_id: deviceId || null,
    wall_ok: wallOk,
    approved: false
  });

  if (!result.ok) { res.status(200).json({ ok: false, error: result.reason }); return; }
  res.status(200).json({ ok: true });
};

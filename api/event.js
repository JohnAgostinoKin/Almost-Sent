// api/event.js
//
// Anonymous interaction logging — never the text itself. That's already
// captured, on its own, in the `inbox` table via api/draft.js's remember().
// This endpoint only ever writes a device id (a random value the client
// generated and stored locally, tied to no identity), an event name from a
// fixed whitelist, and a small structured `meta` object.

const { createLimiter } = require("../lib/rateLimit");

const EVENTS = ["paste", "draft_shown", "another", "own_line", "share"];
const META_LIMIT = 2000; // bytes, generous for {source, provider, revealIndex} — just a guard against abuse

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

function safeMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  try {
    const json = JSON.stringify(meta);
    return json.length > META_LIMIT ? {} : meta;
  } catch (err) {
    return {};
  }
}

const limited = createLimiter();

// Same "don't swallow it" fix as api/draft.js's remember() — a non-2xx
// response used to vanish silently. Now it's console.error'd with the
// status and body so it shows up in Vercel function logs. This endpoint's
// own response stays { ok: true } either way (the client never reads it,
// see the handler below) — the logs are the surface for this one, not
// the ?debug=1 view, which only reflects /api/draft.
async function log(deviceId, event, meta) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const res = await fetch(url + "/rest/v1/events", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ device_id: deviceId, event: event, meta: meta })
    });
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      console.error("supabase events insert failed: " + res.status + " " + body.slice(0, 500));
    }
  } catch (err) {
    console.error("supabase events insert threw: " + (err && err.message));
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
  const deviceId = String(body.device_id || "").trim().slice(0, 100);
  const event = String(body.event || "").trim();
  if (!deviceId || EVENTS.indexOf(event) === -1) { res.status(400).json({ error: "bad event" }); return; }

  await log(deviceId, event, safeMeta(body.meta));

  // Fire-and-forget from the client's point of view — it never awaits or
  // branches on this response, so there's nothing more useful to return.
  res.status(200).json({ ok: true });
};

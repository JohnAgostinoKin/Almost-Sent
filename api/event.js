// api/event.js
//
// Anonymous interaction logging — never the text itself. That's already
// captured, on its own, in the `inbox` table via api/draft.js's remember().
// This endpoint only ever writes a device id (a random value the client
// generated and stored locally, tied to no identity), an event name from a
// fixed whitelist, and a small structured `meta` object.

const { createLimiter } = require("../lib/rateLimit");
const { waitUntil } = require("@vercel/functions");

// "arrival" is the one event logged for a device that isn't yet its own
// device_id's row: a fresh device's first-ever event, fired only when it
// showed up via another device's share link (?r=<their device_id>) — see
// index.html's getDeviceId(). meta carries { ref: <referrer's device_id> },
// nothing else.
//
// "rate" is the one-tap 😂/😐/😬 reaction under a draft (see index.html's
// #react buttons). meta carries { lane, value: "hit"|"meh"|"far",
// position: 1|2|3 } — never the draft text itself, same "no text stored"
// rule as every other event here.
//
// "safety" is logged once per api/draft.js request/response, whatever the
// outcome — every response now carries a `safety` field (see the
// handler), not just a crisis hit. meta carries { state, source }: state
// is "clear" | "ambiguous_distress" | "explicit_crisis" | "block" |
// "crisis" | "skipped" | "failed" (see lib/crisis.js's checkCrisis and
// lib/block.js's classifyBlock for what each means); source is which
// layer produced it — "keyword" (lib/block.js's synchronous regex),
// "classifier" (lib/crisis.js's model pre-check), or "curated" (a
// hand-picked line that never ran either check). Never the pasted text
// itself.
//
// "escalation" is a "make it worse" tap revealing position 2 or 3 (see
// index.html's anotherBtn handler and api/draft.js's handler, which is
// what computes q/shock per draft — escalation is intensity now, not
// just rank, see its own comment). meta carries { position: 2 | 3,
// source: "stored" | "fetched", q, shock }: position is which slot got
// revealed; source is whether it was already sitting in the pool from
// the original request or needed a fresh escalated fetch; q/shock are
// that draft's own scores (both null for a curated or stall draft, which
// never ran the taste judge at all).
const EVENTS = ["paste", "draft_shown", "another", "own_line", "share", "arrival", "rate", "safety", "escalation"];
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
//
// Fired via waitUntil (see the handler), not awaited before responding —
// same reasoning as api/draft.js's remember(): this endpoint's whole job is
// a Supabase write nobody's waiting on, so there's no reason for it to sit
// in the response path. Timed and logged the same way, t_log this time.
async function log(deviceId, event, meta) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const started = Date.now();
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/events", {
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
  } finally {
    console.log("t_log: " + (Date.now() - started) + "ms");
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

  waitUntil(log(deviceId, event, safeMeta(body.meta)));

  // Fire-and-forget from the client's point of view — it never awaits or
  // branches on this response, so there's nothing more useful to return.
  // Now also fire-and-forget from this handler's own point of view: the
  // response above doesn't wait on log() either (see waitUntil, above).
  res.status(200).json({ ok: true });
};

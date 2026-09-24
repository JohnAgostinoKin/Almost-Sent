// api/event.js
//
// Anonymous interaction logging — never the visitor's OWN pasted text.
// That's already captured, on its own, in the `inbox` table via api/
// draft.js's remember(). This endpoint only ever writes a device id (a
// random value the client generated and stored locally, tied to no
// identity), an event name from a fixed whitelist, and a small structured
// `meta` object — one exception below (the "rate" event's own `text`)
// carries this app's OWN generated line, not the visitor's words, which
// is a different thing than the rule above and never crosses it.

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
// position: 1|2|3, text, source }: `text` is this app's OWN generated
// continuation (pool[cursor].text on the client), not the pasted text the
// visitor sent in — the "never store the user's text" rule this file's
// own header states is about their words, not ours, and a rated line
// needs its own text stored somewhere or it can never be recovered later.
// `source` is the SAME "model" | "curated" | "stall" value draft_shown
// already logs (currentSource on the client) — what actually lets
// lib/prompt.js's own live Supabase query only ever pull a real,
// non-stall line into the generator's prompt: a stall reaction would
// otherwise look identical to a real one here, and did, once (see lib/
// postprocess.js's own stall-mimic CRUTCHES entries for the bug this was
// covering for). lib/prompt.js queries every "hit" (😂) row with
// source:"model" from the last 30 days directly (see its own
// fetchHitsFromDb) and rotates the result into the generator's own prompt
// as real-reaction examples, cached in memory for an hour. The wall's own
// single 😂 button (see wall.html) fires the same event with
// meta.source: "wall" instead — never pulled into that query, a contest
// entry is a human's own writing, not the generator's voice — plus
// meta.entry_id (the entries.id it's reacting to) added — that entry's
// own line, not a generated continuation, but the same "our text,
// already public" reasoning applies (see api/entries.js). api/wall.js
// reads entry_id back out to tally and show each entry's own hit count
// on the wall.
//
// "entry" and "entry_email" are the contest submission (index.html's
// #contest, api/entries.js) — logged from the client once the entry
// actually stored, not on every keystroke. "entry" always fires, meta
// carries { wall_ok }; "entry_email" fires ADDITIONALLY, no meta, only
// when an email was given, so how many entrants leave one is visible
// without ever logging the address itself (that's in the entries table,
// not here). Never the line or the sent text either — same rule as
// everywhere else in this file, the real content lives in `entries`.
//
// "stall" is logged whenever a response comes back source:"stall" (see
// api/draft.js's handler) — a request that produced nothing worth
// showing, whatever the reason. meta carries { reason }: one of "no api
// key", "credits" (OpenRouter itself is out of credits — HTTP 402, also
// console.error'd server-side the moment it's seen), "rate limit",
// "parse", "primary timeout", "fallback timeout", "judge-eliminated-all",
// or "safety-eliminated-all" — see classifyStallReason in api/draft.js
// for what each one actually means.
// Never the pasted text itself, same as everywhere else here.
//
// "client_timeout" is logged when a first-show /api/draft request is
// aborted client-side (index.html's FIRST_SHOW_TIMEOUT_MS, 15s) before
// the server answered at all — the visitor sees the same "couldn't write
// that one — try again" state as a stall, but the server never got to
// say why. meta carries { t_elapsed }: ms from the request firing to the
// abort. Separate from "stall" so a function that hung is countable apart
// from one that answered with nothing.
//
// "safety" is logged once per api/draft.js request/response, whatever the
// outcome — every response now carries a `safety` field (see the
// handler), not just a crisis hit. meta carries { state, source }: state
// is "clear" | "ambiguous_distress" | "explicit_crisis" | "near_miss" (both
// crisis models failed and the text had a near-miss word — routed to 988
// without a verdict, see lib/crisis.js's failover) | "block" |
// "crisis" | "skipped" | "failed" (see lib/crisis.js's checkCrisis and
// lib/block.js's classifyBlock for what each means); source is which
// layer produced it — "keyword" (lib/block.js's synchronous regex),
// "classifier" (lib/crisis.js's model pre-check), or "curated" (a
// hand-picked line that never ran either check). Never the pasted text
// itself.
//
// "escalation" is the one "make it worse" tap revealing position 2 (see
// index.html's anotherBtn handler, capped to a single tap now, and api/
// draft.js's handler, which is what computes q/reaction per draft —
// escalation is intensity now, not just rank, see its own comment). meta
// carries { position: 2, source: "stored" | "fetched", q, reaction }:
// source is whether it was already sitting in the pool from the original
// request or needed a fresh escalated fetch; q/reaction are that draft's
// own scores (both null for a curated or stall draft, which never ran
// the taste judge at all). `reaction` was named `shock` before the v4
// judge rewrite (lib/judge.js) — same intensity axis, renamed to match
// what the score actually measures now. position was 2 or 3, uncapped at
// three taps, before the escalation-cap-to-one change.
// "age_gate" is the 18+ overlay on first visit (index.html's #age-gate).
// meta carries { choice: "accept" | "leave" }: "accept" is remembered on the
// device and the gate never shows again; "leave" sends them to google.com and
// isn't remembered. Never the pasted text, same as everywhere else here.
const EVENTS = ["paste", "draft_shown", "another", "share", "arrival", "rate", "safety", "escalation", "entry", "entry_email", "stall", "client_timeout", "age_gate"];
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

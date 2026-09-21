// lib/precomputed.js
//
// Persistent, cross-container result store for api/cron/precompute.js's
// nightly pre-warm. api/draft.js's own result cache is an in-process Map —
// a cron invocation runs in a different container than the one a visitor
// hits, so it can never fill that Map for them. This is the same idea
// backed by Supabase (the `precomputed` table, scripts/precompute-schema.sql)
// so any container can read what the cron wrote.
//
// Everything here fails open: a missing table (SQL not run yet), a slow
// Supabase, or a network error is a cache MISS, never an error a visitor
// sees. A visitor request pays at most READ_TIMEOUT_MS for the lookup.
//
// The key is lib/prompt.js's normalizeBefore(sent) — exactly what the
// in-memory result cache keys on — so "hey" and "Hey." share one entry.

const { normalizeBefore } = require("./prompt");

const READ_TIMEOUT_MS = 500;
// A 404 means the table (or a column) isn't there. Stop asking for a while
// rather than paying a failing round trip on every visitor request until
// the SQL gets run.
const MISSING_BACKOFF_MS = 5 * 60 * 1000;
let missingUntil = 0;

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/+$/, "") + "/rest/v1/precomputed", headers: { apikey: key, Authorization: "Bearer " + key } };
}

function precomputedKey(sent) {
  return normalizeBefore(sent);
}

// One fresh (unexpired) entry for `sent`, or null. Returns the stored
// payload with gen_model folded in.
async function getPrecomputed(sent) {
  const cfg = config();
  if (!cfg || Date.now() < missingUntil) return null;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, READ_TIMEOUT_MS);
  try {
    const qs = "key=eq." + encodeURIComponent(precomputedKey(sent)) +
      "&expires_at=gt." + encodeURIComponent(new Date().toISOString()) +
      "&select=payload,gen_model&limit=1";
    const res = await fetch(cfg.base + "?" + qs, { headers: cfg.headers, signal: controller.signal });
    if (res.status === 404) { missingUntil = Date.now() + MISSING_BACKOFF_MS; return null; }
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length || !rows[0].payload) return null;
    return Object.assign({}, rows[0].payload, { gen_model: rows[0].gen_model || rows[0].payload.gen_model || null });
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Upserts one entry. Returns { ok, status }.
async function putPrecomputed(sent, payload, genModel, ttlMs) {
  const key = precomputedKey(sent);
  if (key.indexOf("__") === 0) return { ok: false, status: "reserved key" };
  return upsertRow(key, payload, genModel, ttlMs);
}

async function upsertRow(key, payload, genModel, ttlMs) {
  const cfg = config();
  if (!cfg) return { ok: false, status: "not configured" };
  try {
    const res = await fetch(cfg.base + "?on_conflict=key", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Prefer: "return=minimal,resolution=merge-duplicates" }, cfg.headers),
      body: JSON.stringify({ key: key, payload: payload, gen_model: genModel, expires_at: new Date(Date.now() + ttlMs).toISOString() })
    });
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      console.error("precomputed upsert failed: " + res.status + " " + body.slice(0, 300));
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error("precomputed upsert threw: " + (err && err.message));
    return { ok: false, status: "error" };
  }
}

// Every unexpired key, for the cron's "already fresh, skip it" check. The
// table is bounded (~top-200 texts, 7-day TTL), so one page is enough.
async function freshKeys() {
  const cfg = config();
  if (!cfg) return { ok: false, status: "not configured", keys: new Set() };
  const res = await fetch(cfg.base + "?select=key&expires_at=gt." + encodeURIComponent(new Date().toISOString()) + "&limit=5000", { headers: cfg.headers });
  if (!res.ok) return { ok: false, status: res.status, keys: new Set() };
  const rows = await res.json();
  return { ok: true, status: 200, keys: new Set(rows.map(function (r) { return r.key; })) };
}

// Per-night spend ledger, stored as an ordinary row so the $ cap holds
// across invocations (a manual re-run, or a second trigger the same night),
// not just within one. normalizeBefore does NOT prevent a pasted text from
// producing a "__"-prefixed key, so putPrecomputed refuses any such key
// outright — a visitor's text can never overwrite (and zero out) a ledger row.
function ledgerKey(day) { return "__spend:" + day; }
// Returns dollars already spent that day, or null if the ledger couldn't be
// read — the caller must treat null as "don't spend", never as zero.
async function readSpend(day) {
  const cfg = config();
  if (!cfg) return null;
  const res = await fetch(cfg.base + "?key=eq." + encodeURIComponent(ledgerKey(day)) + "&select=payload&limit=1", { headers: cfg.headers });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length && rows[0].payload && isFinite(rows[0].payload.usd) ? rows[0].payload.usd : 0;
}
function writeSpend(day, usd) {
  return upsertRow(ledgerKey(day), { usd: usd }, "ledger", 2 * 24 * 60 * 60 * 1000);
}

async function purgeExpired() {
  const cfg = config();
  if (!cfg) return { ok: false, status: "not configured" };
  const res = await fetch(cfg.base + "?expires_at=lt." + encodeURIComponent(new Date().toISOString()), {
    method: "DELETE",
    headers: Object.assign({ Prefer: "return=minimal" }, cfg.headers)
  });
  return { ok: res.ok, status: res.status };
}

module.exports = { getPrecomputed, putPrecomputed, freshKeys, readSpend, writeSpend, purgeExpired, precomputedKey };

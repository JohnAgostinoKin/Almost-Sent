#!/usr/bin/env node
// scripts/hits.js
//
// Pulls every "rate" event logged with value:"hit" (the 😂 tap — see
// index.html's #react buttons and api/event.js's own EVENTS comment) out
// of Supabase, dedupes by lane+text, and writes the result to
// bible/hits.json. lib/prompt.js reads that file at require() time and
// rotates three of them into the wildcard generator's own prompt, ahead
// of the hand-written lane examples — real reactions teaching the model,
// not just curated guesses.
//
// This only works now that the "rate" event's own meta carries `text` —
// this app's OWN generated continuation, never the visitor's pasted text
// (see api/event.js's own header for that distinction). A rate event
// logged before that change has no `text` field and is silently skipped.
//
// Only ever pulls source:"model" or source:"curated" hits — never a
// stall, and never a wall hit (source:"wall", a contest entry, a
// human's own writing, not the generator's voice — see api/event.js and
// api/wall.js). A real incident is why this matters: a stalled draft
// (lib/fallback.js's own filler line, e.g. "hold on, i deleted this one
// twice already") got 😂'd and pulled in here once, which then fed the
// generator its OWN stall vocabulary back as if it were a real joke —
// see lib/postprocess.js's STALL_MIMIC_PHRASES (folded into CRUTCHES
// there) for the matching generator-side fix. isStallMimic is the
// second layer of the same fix: a defensive re-check on the way OUT of
// Supabase too, in case an older row was logged before the "rate" event
// carried `source` at all (those have no source to filter on, so the
// server-side filter alone can't catch them).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...  npm run hits

const fs = require("fs");
const path = require("path");
const { isStallMimic } = require("../lib/postprocess");

// --- tiny .env loader (no dotenv dependency) — same as scripts/bake.js ---
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    val = val.replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. Put them in .env or export them, then re-run.");
  process.exit(1);
}

const OUT_PATH = path.join(__dirname, "..", "bible", "hits.json");

// PostgREST caps a single response — paged with offset/limit so a busy
// table doesn't get silently truncated. Filtered server-side to
// event=rate, meta->>value=hit, meta->>source in (model, curated) — no
// point pulling every "rate" row (meh/far reactions, wall hits, stalls,
// all included) just to throw most of them away client-side.
const PAGE_SIZE = 1000;
async function fetchPage(offset) {
  const qs = "event=eq.rate&meta->>value=eq.hit&meta->>source=in.(model,curated)&select=meta&order=created_at.desc&offset=" + offset + "&limit=" + PAGE_SIZE;
  const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/events?" + qs, {
    headers: { apikey: key, Authorization: "Bearer " + key }
  });
  if (!res.ok) {
    const body = await res.text().catch(function () { return ""; });
    throw new Error("supabase events fetch failed: " + res.status + " " + body.slice(0, 500));
  }
  return res.json();
}

async function main() {
  console.log("hits: pulling every 😂 (\"hit\") rate event from source:model/curated, writing to " + OUT_PATH + "\n");
  let offset = 0;
  let scanned = 0;
  let droppedStallMimic = 0;
  const seen = new Set(); // dedupe key: lane + "|" + text
  const hits = [];
  for (;;) {
    const page = await fetchPage(offset);
    if (!page.length) break;
    scanned += page.length;
    page.forEach(function (row) {
      const meta = row && row.meta;
      const text = meta && String(meta.text || "").trim();
      if (!text) return; // older rows, or ones the client never attached text to
      // Belt and suspenders — see this file's own header on the real
      // incident this covers for. The server-side filter above already
      // excludes source:"stall" for any row that HAS a source; this
      // catches a stall-mimicking line regardless of whether it does.
      if (isStallMimic(text)) { droppedStallMimic++; return; }
      const lane = String((meta && meta.lane) || "unknown");
      const dedupeKey = lane + "|" + text;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      hits.push({ lane: lane, text: text });
    });
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(hits, null, 2));
  console.log("scanned " + scanned + " hit event(s)" +
    (droppedStallMimic ? ", dropped " + droppedStallMimic + " that read like the app's own stall lines" : "") +
    ", wrote " + hits.length + " unique line(s) to " + OUT_PATH);
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});

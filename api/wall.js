// api/wall.js
//
// Public read of the contest wall (see /wall.html) — every entry that's
// both been manually approved and opted into the wall at submission time
// (see api/entries.js and /admin/entries), newest first, each carrying
// its own 😂 tally. No auth: this is meant to be public, same as the app
// itself. Never returns email or device_id — those aren't anyone else's
// business, wall or not.
const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];
const WALL_LIMIT = 300;

// Wall reactions are a "rate" event like any other (see index.html's own
// react buttons and api/event.js's own header) — meta.source:"wall" and
// meta.entry_id (see wall.html's own click handler) are what tie one
// back to a specific entries row. Counted here by pulling every matching
// event and tallying by entry_id in JS, scoped with an `in.()` filter to
// just the entry ids actually on this page rather than the events
// table's whole history. Fine at this app's current scale — if the
// events table ever gets big enough for even that filtered scan to
// matter, this is the query to replace with a real SQL aggregate/view.
// Returns {} (every entry reads as 0 hits) on any failure — a wall
// that's slow or wrong to load matters more than a miscounted tally.
async function fetchHitCounts(url, key, ids) {
  if (!ids.length) return {};
  try {
    const qs = "event=eq.rate&meta->>source=eq.wall&meta->>value=eq.hit&meta->>entry_id=in.(" +
      ids.join(",") + ")&select=meta";
    const res = await fetch(url.replace(/\/+$/, "") + "/rest/v1/events?" + qs, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      console.error("supabase wall hit-count fetch failed: " + res.status + " " + body.slice(0, 500));
      return {};
    }
    const rows = await res.json();
    const counts = {};
    rows.forEach(function (row) {
      const id = row && row.meta && row.meta.entry_id;
      if (id == null) return;
      counts[id] = (counts[id] || 0) + 1;
    });
    return counts;
  } catch (err) {
    console.error("supabase wall hit-count fetch threw: " + (err && err.message));
    return {};
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(200).json({ entries: [] }); return; }

  try {
    const qs = "select=id,sent,text,created_at&approved=eq.true&wall_ok=eq.true&order=created_at.desc&limit=" + WALL_LIMIT;
    const sbRes = await fetch(url.replace(/\/+$/, "") + "/rest/v1/entries?" + qs, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!sbRes.ok) {
      const body = await sbRes.text().catch(function () { return ""; });
      console.error("supabase wall fetch failed: " + sbRes.status + " " + body.slice(0, 500));
      res.status(200).json({ entries: [] });
      return;
    }
    const rows = await sbRes.json();
    const counts = await fetchHitCounts(url, key, rows.map(function (r) { return r.id; }));
    const entries = rows.map(function (r) {
      return { id: r.id, sent: r.sent, text: r.text, created_at: r.created_at, hits: counts[r.id] || 0 };
    });
    res.status(200).json({ entries: entries });
  } catch (err) {
    console.error("supabase wall fetch threw: " + (err && err.message));
    res.status(200).json({ entries: [] });
  }
};

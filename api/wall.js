// api/wall.js
//
// Public read of the contest wall (see /wall.html) — every entry that's
// both been manually approved and opted into the wall at submission time
// (see api/entries.js and /admin/entries), newest first. No auth: this
// is meant to be public, same as the app itself. Never returns email or
// device_id — those aren't anyone else's business, wall or not.
const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];
const WALL_LIMIT = 300;

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
    const qs = "select=sent,text,created_at&approved=eq.true&wall_ok=eq.true&order=created_at.desc&limit=" + WALL_LIMIT;
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
    res.status(200).json({ entries: rows });
  } catch (err) {
    console.error("supabase wall fetch threw: " + (err && err.message));
    res.status(200).json({ entries: [] });
  }
};

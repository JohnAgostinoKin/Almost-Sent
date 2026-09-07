// api/cron/cleanup.js
//
// Nightly job (see vercel.json's `crons` entry) deleting inbox rows older
// than 30 days — the retention window promised in /privacy.html. Assumes
// inbox.created_at exists (the standard Supabase-created-table default);
// if it doesn't, this 500s and logs, rather than silently deleting nothing
// or the wrong rows.
//
// Guarded by CRON_SECRET when set: Vercel attaches
// `Authorization: Bearer <CRON_SECRET>` to its own scheduled invocations
// once that env var exists on the project, so this rejects anyone else
// calling the path directly. With no CRON_SECRET configured, the guard is
// skipped entirely (matches Vercel's own docs — useful for local/dev
// testing, but set it in production).
const RETENTION_DAYS = 30;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.authorization === "Bearer " + secret;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(200).json({ ok: false, reason: "not configured" }); return; }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const del = await fetch(
      url.replace(/\/+$/, "") + "/rest/v1/inbox?created_at=lt." + encodeURIComponent(cutoff),
      {
        method: "DELETE",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          Prefer: "return=minimal"
        }
      }
    );
    if (!del.ok) {
      const body = await del.text().catch(function () { return ""; });
      console.error("supabase inbox cleanup failed: " + del.status + " " + body.slice(0, 500));
      // A real failure gets a non-2xx here (not the 200-with-ok:false
      // pattern api/draft.js uses for remember()) — this endpoint has no
      // user-facing response to protect, and a non-2xx is what lets
      // Vercel's cron dashboard actually show the run as failed.
      res.status(502).json({ ok: false, status: del.status });
      return;
    }
    res.status(200).json({ ok: true, cutoff: cutoff });
  } catch (err) {
    console.error("supabase inbox cleanup threw: " + (err && err.message));
    res.status(500).json({ ok: false, reason: "error" });
  }
};

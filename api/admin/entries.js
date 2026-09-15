// api/admin/entries.js
//
// Protected review queue for contest entries (see /admin-entries.html,
// served at /admin/entries — see vercel.json's rewrite). Auth is a
// single shared secret, ADMIN_SECRET, checked as a bearer token — same
// pattern api/cron/cleanup.js and api/draft.js's keep-warm ping already
// use, just gating a human (John, from a browser) instead of Vercel's
// own cron. No ADMIN_SECRET configured means this endpoint refuses every
// request outright, not "guard skipped" the way CRON_SECRET's absence is
// treated elsewhere — there's a real moderation queue and a real prize
// behind this one, unlike a keep-warm ping.
//
// GET lists every entry (not just approved ones — this IS the review
// queue), newest first. PATCH applies one moderation action to one row:
// {id, action: "approve"|"reject"|"winner"|"unwinner"}.
function isAuthorized(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  return req.headers.authorization === "Bearer " + secret;
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

// approve/reject only ever touch `approved`; winner/unwinner only ever
// touch `winner` — deliberately two independent flags, not one status
// enum, so marking a winner doesn't require re-deciding approval, and
// rejecting a past winner doesn't silently un-winner it behind John's
// back.
const ACTIONS = {
  approve: { approved: true },
  reject: { approved: false },
  winner: { winner: true },
  unwinner: { winner: false }
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (!isAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(200).json({ ok: false, reason: "not configured" }); return; }
  const base = url.replace(/\/+$/, "") + "/rest/v1/entries";

  if (req.method === "GET") {
    try {
      const sbRes = await fetch(base + "?select=*&order=created_at.desc&limit=500", {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });
      if (!sbRes.ok) {
        const errBody = await sbRes.text().catch(function () { return ""; });
        res.status(502).json({ ok: false, reason: errBody.slice(0, 500) });
        return;
      }
      const rows = await sbRes.json();
      res.status(200).json({ ok: true, entries: rows });
    } catch (err) {
      res.status(500).json({ ok: false, reason: "error" });
    }
    return;
  }

  if (req.method === "PATCH") {
    const body = readBody(req);
    const id = body.id;
    const patch = ACTIONS[body.action];
    if (!id || !patch) { res.status(400).json({ ok: false, error: "bad id or action" }); return; }
    try {
      const sbRes = await fetch(base + "?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify(patch)
      });
      if (!sbRes.ok) {
        const errBody = await sbRes.text().catch(function () { return ""; });
        res.status(502).json({ ok: false, reason: errBody.slice(0, 500) });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, reason: "error" });
    }
    return;
  }

  res.status(405).json({ error: "GET or PATCH only" });
};

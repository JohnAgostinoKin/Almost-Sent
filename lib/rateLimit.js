// Per-instance only. Stops casual hammering, not a determined one — a real
// limit needs shared state (Upstash or a Supabase table). Shared by
// api/draft.js and api/event.js, each with its own independent counter
// (createLimiter() per endpoint) so heavy use of one never throttles the
// other.
function createLimiter(opts) {
  const windowMs = (opts && opts.windowMs) || 60000;
  const max = (opts && opts.max) || 20;
  const hits = new Map();
  function limited(ip) {
    const now = Date.now();
    const row = hits.get(ip) || { n: 0, start: now };
    if (now - row.start > windowMs) { row.n = 0; row.start = now; }
    row.n += 1;
    hits.set(ip, row);
    if (hits.size > 5000) hits.clear();
    return row.n > max;
  }
  // Undoes exactly one increment for `ip` — for a request that was
  // counted at the top of the handler (before it's known whether the
  // work behind it will actually cost anything) but turned out to be
  // free, e.g. api/draft.js's result cache: a repeated common input
  // shouldn't burn down the same IP's quota just for asking for
  // something that's already sitting in memory. A no-op if there's
  // nothing to undo (the window already rolled over, or the row was
  // dropped at the 5000-IP cap) — safe to call unconditionally.
  function release(ip) {
    const row = hits.get(ip);
    if (row && row.n > 0) row.n -= 1;
  }
  limited.release = release;
  return limited;
}

module.exports = { createLimiter };

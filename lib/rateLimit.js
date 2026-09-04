// Per-instance only. Stops casual hammering, not a determined one — a real
// limit needs shared state (Upstash or a Supabase table). Shared by
// api/draft.js and api/event.js, each with its own independent counter
// (createLimiter() per endpoint) so heavy use of one never throttles the
// other.
function createLimiter(opts) {
  const windowMs = (opts && opts.windowMs) || 60000;
  const max = (opts && opts.max) || 20;
  const hits = new Map();
  return function limited(ip) {
    const now = Date.now();
    const row = hits.get(ip) || { n: 0, start: now };
    if (now - row.start > windowMs) { row.n = 0; row.start = now; }
    row.n += 1;
    hits.set(ip, row);
    if (hits.size > 5000) hits.clear();
    return row.n > max;
  };
}

module.exports = { createLimiter };

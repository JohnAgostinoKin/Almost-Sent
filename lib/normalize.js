// Used by api/draft.js's remember() to build a stable dedupe key for the
// Supabase inbox table — the same sent text should normalize to the same
// key regardless of trailing punctuation or curly quotes.
function norm(s) {
  const raw = String(s || "").trim();
  const stripped = raw
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Pure-punctuation input (e.g. "?", "??") would otherwise normalize to "".
  return stripped || raw.toLowerCase();
}

module.exports = { norm };

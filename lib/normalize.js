// Shared by the API handler and the bake-off harness so both agree on
// what counts as "the same input" for bank lookups.
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

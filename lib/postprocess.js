const SUSPICIOUS = /developer|instruction|json array|system prompt|as an ai/i;

// Models occasionally fill the array with schema filler instead of an
// actual line ("string1", "Item 2", "lorem ipsum...") — whole-line match
// against common placeholder shapes.
const PLACEHOLDER = /^(string|text|line|item|response|answer|reply|output|value|placeholder|example|foo|bar|baz)\s*[0-9]*[.):]?$|^lorem ipsum\b/i;

// Pull a JSON array of strings out of a model response that may be wrapped
// in markdown fences or have stray commentary around it.
function extractArray(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.map(function (x) { return String(x); });
  } catch (e) {
    return null;
  }
}

function isRefusal(lines) {
  if (!lines || !lines.length) return false;
  const real = lines.map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean);
  if (!real.length) return false;
  return real.every(function (l) { return l === "skip"; });
}

// The cap scales with the input, but a flat multiplier is too tight on
// short reflex texts ("k", "ok", "np") — a landed line is rarely a strict
// substring-length fraction of a two-character input. Give anything under
// 20 chars a flat, more generous floor instead of scaling off its own length.
function lengthCap(inputText) {
  const len = String(inputText || "").length;
  if (len <= 20) return 60;
  return Math.max(len * 1.6, 40);
}

// Drops any line that's too long relative to the input, that reads like
// the model leaked its instructions, or that's schema placeholder filler.
// Returns the surviving lines plus how many were dropped and why, for
// diagnostics.
function filterLines(lines, inputText) {
  const cap = lengthCap(inputText);
  const kept = [];
  let droppedLength = 0;
  let droppedSuspicious = 0;
  (lines || []).forEach(function (raw) {
    const line = String(raw).trim();
    if (!line) return;
    if (line.length > cap) { droppedLength++; return; }
    if (SUSPICIOUS.test(line) || PLACEHOLDER.test(line)) { droppedSuspicious++; return; }
    kept.push(line);
  });
  return { kept: kept, droppedLength: droppedLength, droppedSuspicious: droppedSuspicious, cap: cap };
}

module.exports = { extractArray, isRefusal, filterLines, SUSPICIOUS, PLACEHOLDER, lengthCap };

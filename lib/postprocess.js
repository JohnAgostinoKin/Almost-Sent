const SUSPICIOUS = /developer|instruction|json array|system prompt|as an ai/i;

// Models occasionally fill the array with schema filler instead of an
// actual line ("string1", "Item 2", "lorem ipsum...") — whole-line match
// against common placeholder shapes.
const PLACEHOLDER = /^(string|text|line|item|response|answer|reply|output|value|placeholder|example|foo|bar|baz)\s*[0-9]*[.):]?$|^lorem ipsum\b/i;

// Lines the model reaches for when it's out of ideas — they read as "almost
// sent" but they're a crutch, not a line: vague enough to fit any input,
// worthless the way the prompt's own "dead" examples are worthless. Caught
// as substrings since the model wraps them in other words.
const CRUTCHES = [
  "i need something",
  "not holding my breath",
  "not a priority",
  "not really",
  "i don't actually care",
  "is a strong word",
  "is doing heavy lifting",
  "stove",
  "the oven",
  "crockpot",
  "slow cooker",
  "soak the beans",
  "electric bill",
  "need to remember",
  "need to buy",
  "need to order",
  "did i leave",
  "did i turn off",
  "did i unplug",
  "fuck your",
  "fuck off with",
  "fuck you for",
  "fuck this"
];
// "cat" needs a word-boundary match, not the substring check the rest of
// CRUTCHES uses — a plain indexOf("cat") would also drop "vacation" and
// "catch".
const CRUTCH_WORD_RE = /\bcat\b/i;
function isCrutch(line) {
  const lower = line.toLowerCase();
  if (CRUTCH_WORD_RE.test(line)) return true;
  return CRUTCHES.some(function (c) { return lower.indexOf(c) !== -1; });
}

// Words a line should never land on, no matter how the model gets there:
// the prompt's own "nothing about appearance ... or a named third party"
// rule (face/body/fat/thin/ugly/skinny/weight/teeth/hair/skin/breath), plus
// anything that reads as real-world violence or death (crash/crashes/die/
// dies/dead/kill) — this app is about a deleted draft, not a threat. Whole-
// word match so this doesn't clip unrelated words ("faceless", "breathe",
// "thinner-than-expected margins", "killer playlist" all survive; "face",
// "breath", "thin", "kill" on their own don't).
const WALL_WORDS = /\b(face|body|fat|thin|ugly|skinny|weight|teeth|hair|skin|breath|crash|crashes|die|dies|dead|kill|fall down|stairs|hurt|hospital)\b/i;
function isWallLine(line) {
  return WALL_WORDS.test(line);
}

// Guard against stray non-ASCII characters a model occasionally leaks into
// an otherwise normal line (garbled tokens, a foreign-script fragment) —
// seen for real in bake-final-2.md ("i alreadyลา said this to someone else").
// Curly quotes/apostrophes are common and intentional (models render "don't"
// as don’t), so those stay allowed; anything else outside basic ASCII drops the line.
const NON_ASCII_RE = /[^\x00-\x7F‘’“”]/;
function isNonAscii(line) {
  return NON_ASCII_RE.test(line);
}

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
  let droppedCrutch = 0;
  let droppedWall = 0;
  let droppedAscii = 0;
  (lines || []).forEach(function (raw) {
    const line = String(raw).trim();
    if (!line) return;
    if (line.length > cap) { droppedLength++; return; }
    if (SUSPICIOUS.test(line) || PLACEHOLDER.test(line)) { droppedSuspicious++; return; }
    if (isCrutch(line)) { droppedCrutch++; return; }
    if (isWallLine(line)) { droppedWall++; return; }
    if (isNonAscii(line)) { droppedAscii++; return; }
    kept.push(line);
  });
  return {
    kept: kept,
    droppedLength: droppedLength,
    droppedSuspicious: droppedSuspicious,
    droppedCrutch: droppedCrutch,
    droppedWall: droppedWall,
    droppedAscii: droppedAscii,
    cap: cap
  };
}

module.exports = {
  extractArray,
  isRefusal,
  filterLines,
  SUSPICIOUS,
  PLACEHOLDER,
  CRUTCHES,
  CRUTCH_WORD_RE,
  isCrutch,
  WALL_WORDS,
  isWallLine,
  NON_ASCII_RE,
  isNonAscii,
  lengthCap
};

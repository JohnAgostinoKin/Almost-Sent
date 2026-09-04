const SUSPICIOUS = /developer|instruction|json array|system prompt|as an ai/i;

// Models occasionally fill the array with schema filler instead of an
// actual line ("string1", "Item 2", "lorem ipsum...") — whole-line match
// against common placeholder shapes.
const PLACEHOLDER = /^(string|text|line|item|response|answer|reply|output|value|placeholder|example|foo|bar|baz)\s*[0-9]*[.):]?$|^lorem ipsum\b/i;

// Lines the model reaches for when it's out of ideas. Reset for the
// continuation mechanic (see lib/prompt.js) — the old crutches were shapes
// of the previous rewrite-the-whole-line mechanic and don't describe how a
// continuation goes stale. Starting fresh with only what's actually shown
// up; add to this list as new crutches appear in the debug view.
const CRUTCHES = [
  "is doing a lot of work",
  "is a strong word",
  "need to remember",
  "did i leave",
  "i'd rather be waterboarded",
  "feral raccoon"
];
function isCrutch(line) {
  const lower = line.toLowerCase();
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
//
// "therap" and "suicid" are stems, not whole words, on purpose — they need
// to catch "therapy"/"therapist" and "suicide"/"suicidal" alike, so they sit
// outside the \b...\b group (leading boundary only, no trailing one).
const WALL_WORDS = /\b(face|body|fat|thin|ugly|skinny|weight|teeth|hair|skin|breath|crash|crashes|die|dies|dead|kill|fall down|stairs|hurt|hospital|will to live|parole|organs?|harvest|runways?|the pipe)\b|\btherap|\bsuicid/i;
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

// The continuation mechanic (see lib/prompt.js) means the model is never
// handed the sent text to echo, reply to, or answer — it only ever writes
// what comes after it — so the old echo and direct-answer filters (which
// existed to catch a model parroting or resolving the input) no longer have
// anything to catch; the structure itself rules those failure modes out.
// What replaces them is a check that the structure actually held: a real
// continuation always opens with the punctuation or space that connects it
// to the sent text (see the prompt's own "start with whatever punctuation
// connects it" instruction, and lib/compose.js on the client/harness side,
// which relies on this same convention to render the draft). A line that
// opens with a bare word ignored the format and is, structurally, a full
// replacement line in disguise — drop it rather than let it silently
// concatenate onto the sent text as "sentwordword...".
const OPENER_RE = /^[,.!?\s]/;
function hasValidOpener(line) {
  return OPENER_RE.test(line);
}

// A per-response diversity pass: six lines that all reach for the same
// opening move or the same background prop read as one joke repeated six
// times, not six different ones. Checked against lines already kept from
// this same response (i.e. higher-ranked — the model returns strongest
// first), never against anything outside this call.
function wordsOf(text) {
  return String(text || "").toLowerCase().match(/[a-z']+/g) || [];
}
function firstTwoWords(line) {
  return wordsOf(line).slice(0, 2).join(" ");
}
// Starter list of recurring background nouns the model reaches for when
// it's improvising a bizarre situation — letting two lines in one response
// share one makes them feel like variations on the same bit. Grow this the
// same way CRUTCHES grows, from what repeats in the debug view.
const PROP_NOUNS = ["cat", "dog", "raccoon", "goldfish", "toaster", "ex", "vibrator", "ikea", "lawyer", "landlord"];
function propNounsIn(line) {
  const lower = String(line || "").toLowerCase();
  return PROP_NOUNS.filter(function (w) { return new RegExp("\\b" + w + "s?\\b").test(lower); });
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

// The model occasionally prefixes a line with the shape it was asked for
// ("shock jock: ...") even though the prompt only wants the array of
// strings. Strip it before any filter below sees the line, so the word cap
// counts the actual line and the label itself doesn't get judged as
// content. Tolerates (but doesn't require) leading whitespace, since a
// genuine continuation opener can itself be a bare space — see the
// leading-whitespace handling in filterLines below.
const SHAPE_LABEL_RE = /^\s*(shock jock|absurd|raunchy|unbelievable)\s*:\s*/i;
function stripShapeLabel(line) {
  return line.replace(SHAPE_LABEL_RE, "");
}

const WORD_CAP = 16;
function wordCount(line) {
  return (String(line || "").trim().match(/\S+/g) || []).length;
}

// Drops any line that's over the word cap, that reads like the model leaked
// its instructions, that's schema placeholder filler, or that isn't shaped
// like a continuation. Returns the surviving lines plus how many were
// dropped and why, for diagnostics.
//
// Only trailing whitespace is stripped before these checks run — a leading
// space is a valid, meaningful opener under the continuation mechanic (see
// OPENER_RE above), so a blanket .trim() here would strip the very thing
// hasValidOpener needs to see and wrongly drop every space-led line.
//
// sentText is accepted for signature symmetry with callers that still pass
// it (api/draft.js, scripts/bake.js) but isn't used — nothing here needs
// the original text anymore, only the shape of the continuation itself.
function filterLines(lines, sentText) {
  const kept = [];
  let droppedWords = 0;
  let droppedSuspicious = 0;
  let droppedCrutch = 0;
  let droppedWall = 0;
  let droppedAscii = 0;
  let droppedOpener = 0;
  let droppedDiversity = 0;
  const seenOpeners = [];
  const seenProps = [];
  (lines || []).forEach(function (raw) {
    const line = stripShapeLabel(String(raw).replace(/\s+$/, ""));
    if (!line.trim()) return;
    if (wordCount(line) > WORD_CAP) { droppedWords++; return; }
    if (SUSPICIOUS.test(line) || PLACEHOLDER.test(line)) { droppedSuspicious++; return; }
    if (isCrutch(line)) { droppedCrutch++; return; }
    if (isWallLine(line)) { droppedWall++; return; }
    if (isNonAscii(line)) { droppedAscii++; return; }
    if (!hasValidOpener(line)) { droppedOpener++; return; }
    const opener = firstTwoWords(line);
    const props = propNounsIn(line);
    const openerDup = opener && seenOpeners.indexOf(opener) !== -1;
    const propDup = props.some(function (p) { return seenProps.indexOf(p) !== -1; });
    if (openerDup || propDup) { droppedDiversity++; return; }
    kept.push(line);
    if (opener) seenOpeners.push(opener);
    props.forEach(function (p) { if (seenProps.indexOf(p) === -1) seenProps.push(p); });
  });
  return {
    kept: kept,
    droppedWords: droppedWords,
    droppedSuspicious: droppedSuspicious,
    droppedCrutch: droppedCrutch,
    droppedWall: droppedWall,
    droppedAscii: droppedAscii,
    droppedOpener: droppedOpener,
    droppedDiversity: droppedDiversity
  };
}

// Turns a filterLines() result into a short per-filter breakdown for `why`
// — e.g. "words 3, wall 2, opener 1" — instead of a flat "all N filtered"
// that hides which rule actually did it. Order matches the check order in
// filterLines; zero-count filters are omitted.
const DROP_LABELS = [
  ["droppedWords", "words"],
  ["droppedSuspicious", "suspicious"],
  ["droppedCrutch", "crutch"],
  ["droppedWall", "wall"],
  ["droppedAscii", "ascii"],
  ["droppedOpener", "opener"],
  ["droppedDiversity", "diversity"]
];
function describeDrops(filtered) {
  return DROP_LABELS
    .map(function (pair) { return [pair[1], (filtered && filtered[pair[0]]) || 0]; })
    .filter(function (pair) { return pair[1] > 0; })
    .map(function (pair) { return pair[0] + " " + pair[1]; })
    .join(", ");
}

module.exports = {
  extractArray,
  isRefusal,
  filterLines,
  SUSPICIOUS,
  PLACEHOLDER,
  CRUTCHES,
  isCrutch,
  WALL_WORDS,
  isWallLine,
  NON_ASCII_RE,
  isNonAscii,
  OPENER_RE,
  hasValidOpener,
  PROP_NOUNS,
  propNounsIn,
  firstTwoWords,
  describeDrops,
  SHAPE_LABEL_RE,
  stripShapeLabel,
  WORD_CAP,
  wordCount
};

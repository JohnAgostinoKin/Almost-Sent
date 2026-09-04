const { SHAPES } = require("./prompt");

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
  "feral raccoon",
  "the human equivalent of"
];
function isCrutch(line) {
  const lower = line.toLowerCase();
  return CRUTCHES.some(function (c) { return lower.indexOf(c) !== -1; });
}

// The wall is now just the two categories that don't need judgment: a slur
// is always a slur, and a minor is always out of bounds — no context could
// make either okay in this app. Everything the old wall word list also
// caught (body-shaming words, crash/die/kill, parole/organs cruelty tropes,
// therap/suicid self-harm stems) needed actual judgment to apply well
// (fine as hyperbole, not fine as a real target) — that's now
// lib/judge.js's job, one small-model call reviewing the six lines
// together after this keyword pass runs. See api/draft.js's callOnce for
// how the two stages combine.
//
// SLURS is a short, non-exhaustive list of racial/ethnic slurs. This filter
// doesn't judge context or reclaimed use — the only question it asks is
// "would a stranger reading this on their phone see a slur," and the safe
// answer is always to drop the line. Grow this the same way CRUTCHES and
// PROP_NOUNS grow, from what actually shows up.
const SLURS = ["nigger", "nigga", "chink", "gook", "spic", "wetback", "kike", "beaner", "coon", "raghead", "towelhead", "gypsy"];
const WALL_WORDS = new RegExp(
  "\\b(minor|minors|underage|1[0-7][ -]?year[ -]?old|" + SLURS.join("|") + ")\\b",
  "i"
);
function isWallLine(line) {
  return WALL_WORDS.test(line);
}

// Typographic characters the model reaches for that aren't actually a
// problem — an em dash, curly quotes — get normalized to their plain
// equivalents instead of costing the line a drop: an em dash reads the same
// as a comma-pause in this voice, so it becomes ", "; curly single/double
// quotes become straight ones. Whatever the line normalizes to is what gets
// kept and shown, not the model's original raw text.
const EM_DASH_RE = /—/g;
const CURLY_SINGLE_RE = /[‘’]/g;
const CURLY_DOUBLE_RE = /[“”]/g;
function normalizePunctuation(line) {
  return String(line || "")
    .replace(EM_DASH_RE, ", ")
    .replace(CURLY_SINGLE_RE, "'")
    .replace(CURLY_DOUBLE_RE, '"');
}

// What's left after normalizing typography above only needs to guard
// against one real problem: a genuinely different writing system leaking
// in (garbled tokens, a foreign-script fragment) — seen for real in
// bake-final-2.md ("i alreadyลา said this to someone else"). It's no longer
// a blanket ASCII gate — an accented Latin letter, an ellipsis, ordinary
// punctuation all survive now. \p{Script=Latin} covers Latin letters
// (accented or not); \p{Script=Common} covers digits, punctuation, symbols,
// and whitespace shared across every script; \p{Script=Inherited} covers
// combining marks that ride on the letter before them. A character outside
// all three is a different script, and that's what actually drops a line.
const NON_LATIN_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
function isNonLatin(line) {
  return NON_LATIN_RE.test(line);
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
// this same response, in the order the model wrote them (filterLines runs
// before orderByShape re-sorts for display), never against anything outside
// this call.
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

// Pull a JSON array out of a model response that may be wrapped in markdown
// fences or have stray commentary around it. Returns the parsed array as-is
// (each element still whatever shape the model gave it — normally a
// {shape, text} object, see normalizeItem below) — no longer coerces
// elements to strings here, since that would flatten an object element to
// the useless "[object Object]".
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
    return parsed;
  } catch (e) {
    return null;
  }
}

// A shape outside the known four (missing, misspelled, or the model just
// ignoring the field) becomes "unknown" rather than dropping the line —
// losing a perfectly good line to a formatting slip is worse than showing
// it out of its intended display position (orderByShape below sorts
// "unknown" last).
function normalizeShape(shape) {
  const s = String(shape || "").trim().toLowerCase();
  return SHAPES.indexOf(s) !== -1 ? s : "unknown";
}

// Only a genuine string (or a primitive that stringifies sanely, like a
// number) ever becomes `text`. Something parsed straight out of JSON.parse
// can only be a string, number, boolean, null, array, or plain object — and
// coercing an array or object through String() doesn't fail loudly, it
// quietly produces real-looking-but-wrong text ("a,b" for an array,
// "[object Object]" for an object every single time, regardless of what's
// actually inside it) that could ride the rest of the pipeline as if it
// were a real line. Anything that isn't already a string/number/boolean
// becomes no text at all instead, which then falls out cleanly through
// filterLines' existing empty-line drop rather than surfacing as garbage —
// this is the fix for the "[object Object]" rendering bug: it closes the
// one place upstream of every draft display (the live draft, "another",
// the share block, the ?debug=1 line list) that could ever manufacture that
// exact string.
function normalizeText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

// Turns one raw element from extractArray's output into a {shape, text}
// line. Handles the real case (the model returned {shape, text} per the
// prompt) and, defensively, a bare string (an older-style response, or a
// model that ignored the object contract) — the text is kept either way,
// only the shape tag is lost.
function normalizeItem(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { shape: normalizeShape(raw.shape), text: normalizeText(raw.text) };
  }
  return { shape: "unknown", text: normalizeText(raw) };
}

function isRefusal(items) {
  if (!items || !items.length) return false;
  const real = items.map(function (it) { return String((it && it.text) || "").trim().toLowerCase(); }).filter(Boolean);
  if (!real.length) return false;
  return real.every(function (l) { return l === "skip"; });
}

// Fixed shape priority for display — no more strongest-first ranking, the
// order is decided entirely by shape. Absurd always sits third. The other
// three shapes (shock, raunchy, unbelievable) rotate through the remaining
// three slots — which one leads (position one) cycles to the next of the
// three on every call (nextLeadIndex), landing back on the same shape every
// third text, so no one shape is permanently favored. The two shapes that
// didn't lead fill position two and position four in the same rotating
// order (the one right after lead in the cycle goes second, the one after
// that goes last) — a normal visitor only ever sees the first three (see
// index.html's MAX_REVEALS), so position four rarely surfaces past
// ?debug=1.
//
// Multiple lines sharing a shape keep the order the model returned them in
// (stable sort) — this only decides shape-group order, never anything
// within a group.
const LEAD_CYCLE = ["shock", "raunchy", "unbelievable"];
let leadIndex = -1;
function nextLeadIndex() {
  leadIndex = (leadIndex + 1) % LEAD_CYCLE.length;
  return leadIndex;
}
function orderByShape(items) {
  const leadPos = nextLeadIndex();
  const rank = [
    LEAD_CYCLE[leadPos],
    LEAD_CYCLE[(leadPos + 1) % LEAD_CYCLE.length],
    "absurd",
    LEAD_CYCLE[(leadPos + 2) % LEAD_CYCLE.length]
  ];
  return (items || [])
    .map(function (item, i) { return { item: item, i: i }; })
    .sort(function (a, b) {
      const ra = rank.indexOf(a.item.shape);
      const rb = rank.indexOf(b.item.shape);
      const ra2 = ra === -1 ? rank.length : ra;
      const rb2 = rb === -1 ? rank.length : rb;
      return ra2 !== rb2 ? ra2 - rb2 : a.i - b.i;
    })
    .map(function (x) { return x.item; });
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

const WORD_CAP = 24;
function wordCount(line) {
  return (String(line || "").trim().match(/\S+/g) || []).length;
}

// Drops any line that's over the word cap, that reads like the model leaked
// its instructions, that's schema placeholder filler, or that isn't shaped
// like a continuation. Returns the surviving lines plus how many were
// dropped and why, for diagnostics.
//
// Takes {shape, text} items (see normalizeItem above), not bare strings —
// the shape rides along on every line, kept and dropped alike, so `all`
// below can show it in the ?debug=1 view regardless of what happened to the
// line.
//
// Only trailing whitespace is stripped before these checks run — a leading
// space is a valid, meaningful opener under the continuation mechanic (see
// OPENER_RE above), so a blanket .trim() here would strip the very thing
// hasValidOpener needs to see and wrongly drop every space-led line.
//
// sentText is accepted for signature symmetry with callers that still pass
// it (api/draft.js, scripts/bake.js) but isn't used — nothing here needs
// the original text anymore, only the shape of the continuation itself.
function filterLines(items, sentText) {
  const kept = [];
  const all = [];
  let droppedWords = 0;
  let droppedSuspicious = 0;
  let droppedCrutch = 0;
  let droppedWall = 0;
  let droppedScript = 0;
  let droppedOpener = 0;
  let droppedDiversity = 0;
  const seenOpeners = [];
  const seenProps = [];
  (items || []).forEach(function (item) {
    const shape = (item && item.shape) || "unknown";
    // Typography is normalized before anything else looks at the line, so
    // every check below (word count included) sees the same text that
    // ends up kept and shown — not the model's raw em-dashed, curly-quoted
    // original.
    const line = normalizePunctuation(stripShapeLabel(String((item && item.text) || "").replace(/\s+$/, "")));
    function drop(filterName, count) {
      if (count) count();
      all.push({ shape: shape, text: line, dropped: true, filter: filterName });
    }
    if (!line.trim()) { drop("empty"); return; }
    if (wordCount(line) > WORD_CAP) { drop("words", function () { droppedWords++; }); return; }
    if (SUSPICIOUS.test(line) || PLACEHOLDER.test(line)) { drop("suspicious", function () { droppedSuspicious++; }); return; }
    if (isCrutch(line)) { drop("crutch", function () { droppedCrutch++; }); return; }
    if (isWallLine(line)) { drop("wall", function () { droppedWall++; }); return; }
    if (isNonLatin(line)) { drop("script", function () { droppedScript++; }); return; }
    if (!hasValidOpener(line)) { drop("opener", function () { droppedOpener++; }); return; }
    const opener = firstTwoWords(line);
    const props = propNounsIn(line);
    const openerDup = opener && seenOpeners.indexOf(opener) !== -1;
    const propDup = props.some(function (p) { return seenProps.indexOf(p) !== -1; });
    if (openerDup || propDup) { drop("diversity", function () { droppedDiversity++; }); return; }
    kept.push({ shape: shape, text: line });
    all.push({ shape: shape, text: line, dropped: false, filter: null });
    if (opener) seenOpeners.push(opener);
    props.forEach(function (p) { if (seenProps.indexOf(p) === -1) seenProps.push(p); });
  });
  return {
    kept: kept,
    all: all,
    droppedWords: droppedWords,
    droppedSuspicious: droppedSuspicious,
    droppedCrutch: droppedCrutch,
    droppedWall: droppedWall,
    droppedScript: droppedScript,
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
  ["droppedScript", "script"],
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
  normalizeShape,
  normalizeText,
  normalizeItem,
  isRefusal,
  orderByShape,
  filterLines,
  SUSPICIOUS,
  PLACEHOLDER,
  CRUTCHES,
  isCrutch,
  SLURS,
  WALL_WORDS,
  isWallLine,
  EM_DASH_RE,
  CURLY_SINGLE_RE,
  CURLY_DOUBLE_RE,
  normalizePunctuation,
  NON_LATIN_RE,
  isNonLatin,
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

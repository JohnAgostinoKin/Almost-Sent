const { ALL_LANES, LANES } = require("./prompt");

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
  "the equivalent of",
  "kettle",
  "porch light"
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

// Deterministic cleanup pass, applied to every continuation in filterLines
// below before anything downstream (display, share text, the judge's
// composed exchange) ever sees it — a model-written typo like "sorry, i
// fell asleep !" used to reach the screen as-is; this closes that gap the
// same way normalizePunctuation above closes the em-dash/curly-quote one.
const SPACE_BEFORE_PUNCT_RE = /\s+([,.!?;:])/g;
const REPEATED_PUNCT_RE = /([!?,;:])\1+/g;
const REPEATED_WORD_RE = /\b(\w+)(\s+\1\b)+/gi;
const TRAILING_WS_RE = /\s+$/;
function tidy(line) {
  let t = String(line || "");
  t = t.replace(SPACE_BEFORE_PUNCT_RE, "$1");
  // Runs of dots are the one punctuation mark that isn't just "collapse to
  // one" — exactly three is a deliberate ellipsis, not a typo, so it's left
  // alone; any other run (two, four-plus) collapses to whichever of "." or
  // "..." it was more likely reaching for.
  t = t.replace(/\.{2,}/g, function (m) { return m.length === 2 ? "." : "..."; });
  t = t.replace(REPEATED_PUNCT_RE, "$1");
  // Adjacent, case-insensitive repeats only ("the the" -> "the") — not a
  // general duplicate-word scan, which would misfire on a deliberate
  // repetition further apart in the line.
  t = t.replace(REPEATED_WORD_RE, "$1");
  t = t.replace(TRAILING_WS_RE, "");

  // A stray capital at the very start of the actual content (after
  // whatever leading connector — see OPENER_RE below — the line opens
  // with) reads as a mistake the "Lowercase" prompt rule was supposed to
  // prevent; lowercased here rather than left for a human to notice. "I"
  // is the one exception — standalone, or leading a contraction ("I'm",
  // "I've") reads the same as the pronoun either way, and forcing it to
  // "i" mid-cleanup looks like a new typo, not a fix. Only the character
  // immediately after the capital decides that: a letter means it's the
  // start of a longer word ("Insane"), not the pronoun, so it still gets
  // lowercased.
  const m = t.match(/^([^a-zA-Z]*)([A-Z])/);
  if (m) {
    const letterIdx = m[1].length;
    const nextChar = t.charAt(letterIdx + 1);
    const isStandaloneI = m[2] === "I" && !/[a-zA-Z]/.test(nextChar);
    if (!isStandaloneI) {
      t = t.slice(0, letterIdx) + t.charAt(letterIdx).toLowerCase() + t.slice(letterIdx + 1);
    }
  }

  return t;
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
// opens with a letter ignored the format, but the line itself is usually
// still fine — filterLines below fixes it up by prepending ". " instead of
// throwing the line away. Only an opener that's neither valid punctuation
// nor a letter (a stray symbol, a bare digit) is, structurally, unsalvageable
// and still gets dropped.
const OPENER_RE = /^[,.!?\s]/;
function hasValidOpener(line) {
  return OPENER_RE.test(line);
}
const STARTS_WITH_LETTER_RE = /^\p{L}/u;
function startsWithLetter(line) {
  return STARTS_WITH_LETTER_RE.test(line);
}

// A model occasionally just echoes one of the few-shot examples from its
// own system prompt instead of writing something new — every lane's
// examples are injected as "learn from these", not "reuse these" (see
// lib/prompt.js's LANES). Compared against every lane's examples, not just
// whichever lane a given candidate claims — a copy is a copy whichever lane
// it came from, and comparing against the whole pool is just as cheap as
// tracking per-call subsets. Case-insensitive and punctuation-normalized:
// an em dash vs a comma, or a capitalized letter, shouldn't be what saves a
// line that's otherwise an exact copy.
function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
const POOL_AFTERS = ALL_LANES.reduce(function (acc, laneId) {
  return acc.concat(LANES[laneId].examples.map(function (e) { return normalizeForCompare(e.after); }));
}, []);
function isPoolCopy(line) {
  return POOL_AFTERS.indexOf(normalizeForCompare(line)) !== -1;
}

// A keyword-based "does this open like a reply, not a continuation"
// check used to live here (a fixed first-word list — "why", "no", "yeah",
// "sure", "fine", "ok" — plus a couple of fixed prefixes). Retired: it
// couldn't tell a genuine reply-shaped opener from a legitimate reversal
// that happens to start with one of those words for real continuation
// reasons ("no worries" -> ". no, several worries..." got killed by this
// exact list), and lib/judge.js's taste judge already checks the same
// thing properly — gate 1, "continues", asks a model whether the line
// grammatically continues the sender's own message rather than reading as
// an answer to a separate one. A model weighing the whole line in context
// catches this better than a fixed word list ever could, without the
// false positives.

// A per-response diversity pass: lines that all reach for the same opening
// move or the same background prop read as one joke repeated, not several
// different ones. Used to live inside filterLines, checked against every
// kept line regardless of whether that line ever actually made it to the
// screen — a line dropped later by the judge (or never even judged, in the
// backfill scheme — see api/draft.js's callOnce) still "used up" an opener
// or a prop for lines the visitor never saw. createDiversityTracker below
// is driven from callOnce instead, fed only the lines that actually survive
// judging, in display order, so a duplicate only counts against a real,
// visible line.
//
// Similes live here too, not as an outright drop (see lib/prompt.js's
// "never a simile" rule for the aspiration — one slipping through anyway
// isn't the crime a crutch phrase or a wall word is). One simile in a
// response reads as a stylistic choice; two reads as the model leaning on
// the crutch. Caught the same "like a ___" / "as a ___" way regardless of
// what fills the blank, rather than trying to list every noun a simile
// could reach for the way the string CRUTCHES list does.
const SIMILE_RE = /\b(like|as) an? \w/;
function isSimile(line) {
  return SIMILE_RE.test(line.toLowerCase());
}
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
//
// Entries don't have to be single words — the \bs?\b suffix below is a
// harmless no-op on a phrase that doesn't pluralize (it only ever matters
// for the single-noun entries).
const PROP_NOUNS = ["cat", "dog", "raccoon", "goldfish", "toaster", "vibrator", "ikea", "lawyer", "landlord", "bad decisions", "lose the pants", "the sheets"];
function propNounsIn(line) {
  const lower = String(line || "").toLowerCase();
  return PROP_NOUNS.filter(function (w) { return new RegExp("\\b" + w + "s?\\b").test(lower); });
}

// Stateful diversity tracker for one response, driven line-by-line as
// callOnce (api/draft.js) confirms judge survivors — isDuplicate() never
// mutates state (safe to check a candidate before deciding whether to
// judge it at all), record() is the only thing that grows what future
// checks compare against, and it's only ever called for a line that's
// actually going to be shown.
function createDiversityTracker() {
  const seenOpeners = [];
  const seenProps = [];
  let seenSimile = false;
  return {
    isDuplicate: function (line) {
      const opener = firstTwoWords(line);
      const props = propNounsIn(line);
      const simile = isSimile(line);
      const openerDup = opener && seenOpeners.indexOf(opener) !== -1;
      const propDup = props.some(function (p) { return seenProps.indexOf(p) !== -1; });
      const simileDup = simile && seenSimile;
      return openerDup || propDup || simileDup;
    },
    record: function (line) {
      const opener = firstTwoWords(line);
      const props = propNounsIn(line);
      const simile = isSimile(line);
      if (opener) seenOpeners.push(opener);
      props.forEach(function (p) { if (seenProps.indexOf(p) === -1) seenProps.push(p); });
      if (simile) seenSimile = true;
    }
  };
}

// Pull a JSON array out of a model response that may be wrapped in markdown
// fences or have stray commentary around it. Returns the parsed array as-is
// (each element still whatever shape the model gave it — normally a
// {lane, anchor, text} object, see normalizeItem below) — no longer
// coerces elements to strings here, since that would flatten an object
// element to the useless "[object Object]".
//
// v2 also had extractSingle here, a lenient fallback for the old n=1 lead
// request (exactly one line, and a model would occasionally drop the array
// wrapper and return a bare object). Retired along with that request shape
// — both v3 generator calls always ask for an array of several objects
// (eight primary lanes, two wildcard lanes), never exactly one, so there's
// no "wrote one object, dropped the wrapper" case left to be lenient about.
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

// A lane outside ALL_LANES (missing, misspelled, or the model just
// ignoring the field) becomes "unknown" rather than dropping the line —
// losing a perfectly good line to a formatting slip is worse than losing
// track of which lane wrote it. "skip" also normalizes to "unknown" here —
// isRefusal (below) is what actually decides refusal, off `text`, not off
// this field, so a skip response's lane tag doesn't need special handling.
function normalizeLane(lane) {
  const l = String(lane || "").trim().toLowerCase();
  return ALL_LANES.indexOf(l) !== -1 ? l : "unknown";
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

// Turns one raw element from extractArray's output into a {lane, anchor,
// text} candidate. Handles the real case (the model returned the full
// object per the prompt's schema) and, defensively, a bare string (an
// older-style response, or a model that ignored the object contract) —
// the text is kept either way; anchor/lane are lost, which lib/judge.js's
// gates (see api/draft.js) will simply score against an empty anchor and
// fail honestly rather than crash.
function normalizeItem(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return {
      lane: normalizeLane(raw.lane),
      anchor: normalizeText(raw.anchor),
      text: normalizeText(raw.text)
    };
  }
  return { lane: "unknown", anchor: "", text: normalizeText(raw) };
}

function isRefusal(items) {
  if (!items || !items.length) return false;
  const real = items.map(function (it) { return String((it && it.text) || "").trim().toLowerCase(); }).filter(Boolean);
  if (!real.length) return false;
  return real.every(function (l) { return l === "skip"; });
}

// Display order is no longer this module's job. v2's orderByShape rotated
// a fixed shape priority because there was nothing else to rank lines
// by — now every surviving candidate goes to lib/judge.js's gate-and-score
// pass (see api/draft.js), and its own `ranked` output IS the display
// order, best first. Sorting shortest-first within a shape group, or
// deciding which shape leads, doesn't mean anything once the judge is the
// one deciding what's actually best.

// The model occasionally prefixes a line with the lane heading it was
// asked to write ("SUBTEXT: ...") even though the prompt only wants the
// JSON object. Strip it before any filter below sees the line, so the word
// cap counts the actual line and the label itself doesn't get judged as
// content. Tolerates (but doesn't require) leading whitespace, since a
// genuine continuation opener can itself be a bare space — see the
// leading-whitespace handling in filterLines below. Built from
// lib/prompt.js's LANES headings rather than a hand-maintained list, so a
// lane rename or addition doesn't leave this silently stale.
const LANE_LABEL_RE = new RegExp(
  "^\\s*(" + ALL_LANES.map(function (id) { return LANES[id].heading; }).join("|") + ")\\s*:\\s*",
  "i"
);
function stripLaneLabel(line) {
  return line.replace(LANE_LABEL_RE, "");
}

const WORD_CAP = 18;
function wordCount(line) {
  return (String(line || "").trim().match(/\S+/g) || []).length;
}

// Drops any line that's over the word cap, that reads like the model leaked
// its instructions, that's schema placeholder filler, or that isn't shaped
// like a continuation. Returns the surviving lines plus how many were
// dropped and why, for diagnostics.
//
// Does NOT do diversity dedup (opener/prop/simile repeats) — that used to
// happen here, checked against every kept line whether or not it ever
// actually got shown. It's now applied later, in api/draft.js's callOnce,
// scoped to lines that actually survive judging (see createDiversityTracker
// above for why).
//
// Takes {lane, anchor, text} items (see normalizeItem above), not bare
// strings — lane/anchor ride along on every line, kept and dropped alike,
// so `all` below can show them in the ?debug=1 view regardless of what
// happened to the line, and lib/judge.js's gates (see api/draft.js) have
// an anchor to check against once a candidate survives this pass.
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
  let droppedPool = 0;
  let droppedWall = 0;
  let droppedScript = 0;
  let droppedOpener = 0;
  (items || []).forEach(function (item) {
    const lane = (item && item.lane) || "unknown";
    const anchor = (item && item.anchor) || "";
    // Typography is normalized, then the line is tidied (see tidy() above
    // — stray spaces before punctuation, doubled punctuation, repeated
    // words, a stray leading capital), before anything else looks at it —
    // every check below (word count included) sees the same text that
    // ends up kept, shown, shared, and judged, not the model's raw
    // em-dashed, double-punctuated original. `let`, not `const`: the
    // opener check below can rewrite this in place (prepending ". ")
    // rather than dropping the line.
    let line = tidy(normalizePunctuation(stripLaneLabel(String((item && item.text) || "").replace(/\s+$/, ""))));
    function drop(filterName, count) {
      if (count) count();
      all.push({ lane: lane, anchor: anchor, text: line, dropped: true, filter: filterName });
    }
    if (!line.trim()) { drop("empty"); return; }
    if (wordCount(line) > WORD_CAP) { drop("words", function () { droppedWords++; }); return; }
    if (SUSPICIOUS.test(line) || PLACEHOLDER.test(line)) { drop("suspicious", function () { droppedSuspicious++; }); return; }
    if (isCrutch(line)) { drop("crutch", function () { droppedCrutch++; }); return; }
    if (isPoolCopy(line)) { drop("pool", function () { droppedPool++; }); return; }
    if (isWallLine(line)) { drop("wall", function () { droppedWall++; }); return; }
    if (isNonLatin(line)) { drop("script", function () { droppedScript++; }); return; }
    if (!hasValidOpener(line)) {
      if (!startsWithLetter(line)) { drop("opener", function () { droppedOpener++; }); return; }
      line = ". " + line;
    }
    kept.push({ lane: lane, anchor: anchor, text: line });
    all.push({ lane: lane, anchor: anchor, text: line, dropped: false, filter: null });
  });
  return {
    kept: kept,
    all: all,
    droppedWords: droppedWords,
    droppedSuspicious: droppedSuspicious,
    droppedCrutch: droppedCrutch,
    droppedPool: droppedPool,
    droppedWall: droppedWall,
    droppedScript: droppedScript,
    droppedOpener: droppedOpener
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
  ["droppedPool", "pool"],
  ["droppedWall", "wall"],
  ["droppedScript", "script"],
  ["droppedOpener", "opener"]
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
  normalizeLane,
  normalizeText,
  normalizeItem,
  isRefusal,
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
  SPACE_BEFORE_PUNCT_RE,
  REPEATED_PUNCT_RE,
  REPEATED_WORD_RE,
  tidy,
  NON_LATIN_RE,
  isNonLatin,
  OPENER_RE,
  hasValidOpener,
  STARTS_WITH_LETTER_RE,
  startsWithLetter,
  normalizeForCompare,
  POOL_AFTERS,
  isPoolCopy,
  PROP_NOUNS,
  propNounsIn,
  SIMILE_RE,
  isSimile,
  firstTwoWords,
  createDiversityTracker,
  describeDrops,
  LANE_LABEL_RE,
  stripLaneLabel,
  WORD_CAP,
  wordCount
};

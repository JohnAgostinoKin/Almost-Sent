// lib/legacy/postprocess-v2.js — frozen snapshot, see prompt-v2.js's own
// header comment. Only consumer is scripts/bake-blind.js's system A.
const { ACTIVE_SHAPES, EXAMPLES, CODE_TO_SHAPE } = require("./prompt-v2");

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
// own system prompt instead of writing something new — the pool is injected
// as "learn from these", not "reuse these" (see lib/prompt.js's EXAMPLES).
// Compared against every example ever taught, including retired shapes' —
// a copy is a copy whichever shape it came from — not just the subset
// actually sampled into this request's prompt, since tracking that per-call
// isn't worth it when comparing against the whole pool is just as cheap.
// Case-insensitive and punctuation-normalized: an em dash vs a comma, or a
// capitalized letter, shouldn't be what saves a line that's otherwise an
// exact copy.
function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
const POOL_AFTERS = EXAMPLES.map(function (e) { return normalizeForCompare(e.after); });
function isPoolCopy(line) {
  return POOL_AFTERS.indexOf(normalizeForCompare(line)) !== -1;
}

// A continuation of the sender's OWN text can never open like an answer to
// someone else's question — that's a reply, not a continuation, and it's
// structurally wrong the same way a bare-word opener is (see OPENER_RE
// above). Checked on whatever comes after the connector (the leading
// punctuation/space every continuation opens with) so the connector itself
// never counts as the first word.
const REPLY_FIRST_WORDS = ["why", "no", "yes", "yeah", "nah", "sure", "fine", "ok"];
const REPLY_PREFIX_RE = /^(i'd rather not|i can't)\b/i;
function isReplyShaped(line) {
  const rest = String(line || "").replace(/^[,.!?\s]+/, "").trim().toLowerCase();
  if (!rest) return false;
  if (REPLY_PREFIX_RE.test(rest)) return true;
  const firstWord = (rest.match(/[a-z']+/) || [])[0];
  return firstWord ? REPLY_FIRST_WORDS.indexOf(firstWord) !== -1 : false;
}

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

// Same job as extractArray, but for the n=1 lead request specifically
// (see api/draft.js's callOnce): the prompt asks for exactly one line, and
// a model — seen concretely from gpt-5.4 as the fallback model — sometimes
// drops the wrapping array and just returns the bare {"shape":...,
// "text":...} object instead of [{"shape":...,"text":...}]. Tries the
// strict array parse first (the common, correctly-formatted case); only
// if that fails does it look for a bare {...} object and wrap it in a
// one-element array. Never used for a multi-line request (n=4, or the
// legacy/bake full batch) — a bare object there would silently turn "the
// model only wrote one of the four lines we asked for" into something
// that looks like ordinary partial output instead of the format slip it
// actually is.
function extractSingle(raw) {
  const arr = extractArray(raw);
  if (arr) return arr;
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return [parsed];
  } catch (e) {
    return null;
  }
}

// A shape outside the currently active set (missing, misspelled, a retired
// shape like "absurd", or the model just ignoring the field) becomes
// "unknown" rather than dropping the line — losing a perfectly good line to
// a formatting slip is worse than showing it out of its intended display
// position (orderByShape below sorts "unknown" last).
//
// The prompt now asks for a single-letter code ("s"/"r"/"d"/"g" — see
// lib/prompt.js's SHAPE_META) instead of the full word, to trim output
// tokens — this accepts either: the code (the expected case) via
// CODE_TO_SHAPE, or the full word (defensive, in case a model ignores the
// instruction and writes "shock" anyway). Either way the result is always
// the full shape name, which is what everything downstream — SHAPE_META
// lookups, orderByShape's grouping, isCrutch, etc. — keys off.
function normalizeShape(shape) {
  const s = String(shape || "").trim().toLowerCase();
  if (ACTIVE_SHAPES.indexOf(s) !== -1) return s;
  const fromCode = CODE_TO_SHAPE[s];
  if (fromCode && ACTIVE_SHAPES.indexOf(fromCode) !== -1) return fromCode;
  return "unknown";
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

// Fixed shape priority for display — the order is decided entirely by
// shape, driven off ACTIVE_SHAPES (lib/prompt.js), not by how strong the
// model thought a line was. The rest of the lines interleave round-robin
// through the active shapes starting at `leadPos` (default 0), rather than
// clumping every line of one shape before the next — e.g. with shock
// leading and raunchy trailing, the lines land shock/raunchy/shock/raunchy,
// not all shocks then all raunchys.
//
// Rotating which shape leads used to be this function's own job (an
// internal, auto-incrementing counter) back when one request generated all
// the shapes together. Now the actual lead line comes from its own,
// separate n=1 request (see api/draft.js) — the client decides which shape
// that is and tells the server via the `lead` param, so there's no
// "leading position" left for THIS function to rotate: it only ever orders
// a request's own lines among themselves (the alternates call's n=4, or a
// legacy/bake full-batch call), never picks what leads the whole result.
// `leadPos` defaults to 0 (fixed) accordingly; pass it explicitly only if
// some future caller actually needs a specific starting shape.
//
// Multiple lines sharing a shape are sorted shortest-first (by word count)
// before the round-robin below, not left in the order the model returned
// them — each shape's own queue is only ever shifted from the front, so this
// is also what puts the tightest line of the leading shape into position
// one: the lead is always the shortest line available, not whichever one the
// model happened to write first.
// A shape outside ACTIVE_SHAPES (only possible via normalizeShape returning
// "unknown") sorts after every active-shape line, in original order.
function orderByShape(items, leadPos) {
  const pos = leadPos || 0;
  const rotation = ACTIVE_SHAPES.map(function (_, i) { return ACTIVE_SHAPES[(pos + i) % ACTIVE_SHAPES.length]; });
  const groups = {};
  rotation.forEach(function (s) { groups[s] = []; });
  const rest = [];
  (items || []).forEach(function (item) {
    if (groups[item.shape]) groups[item.shape].push(item);
    else rest.push(item);
  });
  rotation.forEach(function (s) {
    groups[s].sort(function (a, b) { return wordCount(a.text) - wordCount(b.text); });
  });
  const ordered = [];
  let added = true;
  while (added) {
    added = false;
    rotation.forEach(function (s) {
      if (groups[s].length) {
        ordered.push(groups[s].shift());
        added = true;
      }
    });
  }
  return ordered.concat(rest);
}

// The model occasionally prefixes a line with the shape it was asked for
// ("shock jock: ...") even though the prompt only wants the array of
// strings. Strip it before any filter below sees the line, so the word cap
// counts the actual line and the label itself doesn't get judged as
// content. Tolerates (but doesn't require) leading whitespace, since a
// genuine continuation opener can itself be a bare space — see the
// leading-whitespace handling in filterLines below.
const SHAPE_LABEL_RE = /^\s*(shock jock|absurd|raunchy|unbelievable|deranged|gross)\s*:\s*/i;
function stripShapeLabel(line) {
  return line.replace(SHAPE_LABEL_RE, "");
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
  let droppedPool = 0;
  let droppedWall = 0;
  let droppedScript = 0;
  let droppedOpener = 0;
  let droppedReply = 0;
  (items || []).forEach(function (item) {
    const shape = (item && item.shape) || "unknown";
    // Typography is normalized, then the line is tidied (see tidy() above
    // — stray spaces before punctuation, doubled punctuation, repeated
    // words, a stray leading capital), before anything else looks at it —
    // every check below (word count included) sees the same text that
    // ends up kept, shown, shared, and judged, not the model's raw
    // em-dashed, double-punctuated original. `let`, not `const`: the
    // opener check below can rewrite this in place (prepending ". ")
    // rather than dropping the line.
    let line = tidy(normalizePunctuation(stripShapeLabel(String((item && item.text) || "").replace(/\s+$/, ""))));
    function drop(filterName, count) {
      if (count) count();
      all.push({ shape: shape, text: line, dropped: true, filter: filterName });
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
    if (isReplyShaped(line)) { drop("reply", function () { droppedReply++; }); return; }
    kept.push({ shape: shape, text: line });
    all.push({ shape: shape, text: line, dropped: false, filter: null });
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
    droppedOpener: droppedOpener,
    droppedReply: droppedReply
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
  ["droppedOpener", "opener"],
  ["droppedReply", "reply"]
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
  extractSingle,
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
  REPLY_FIRST_WORDS,
  REPLY_PREFIX_RE,
  isReplyShaped,
  PROP_NOUNS,
  propNounsIn,
  SIMILE_RE,
  isSimile,
  firstTwoWords,
  createDiversityTracker,
  describeDrops,
  SHAPE_LABEL_RE,
  stripShapeLabel,
  WORD_CAP,
  wordCount
};

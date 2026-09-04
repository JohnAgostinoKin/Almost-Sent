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
//
// "therap" and "suicid" are stems, not whole words, on purpose — they need
// to catch "therapy"/"therapist" and "suicide"/"suicidal" alike, so they sit
// outside the \b...\b group (leading boundary only, no trailing one).
const WALL_WORDS = /\b(face|body|fat|thin|ugly|skinny|weight|teeth|hair|skin|breath|crash|crashes|die|dies|dead|kill|fall down|stairs|hurt|hospital|will to live)\b|\btherap|\bsuicid/i;
function isWallLine(line) {
  return WALL_WORDS.test(line);
}

// Drops a line that's mostly just the input handed back — a model that
// regurgitates the sender's own text isn't writing a punchline. The twist
// shape is explicitly allowed to reuse up to three of the input's words
// (see the prompt); this filter is the backstop for when a model reuses
// far more than that. Three checks, any one of which drops the line:
//   1. the input appears verbatim, in full, anywhere in the line.
//   2. more than half the input's words show up in the line in the same
//      relative order — a paraphrase-shaped echo, not just a verbatim one.
//   3. stripping the input out (whole-word match) leaves fewer than three
//      real words — the line leaned on the input to pad itself out.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function echoPattern(sentText) {
  const trimmed = String(sentText || "").trim();
  if (!trimmed) return null;
  const escaped = escapeRegExp(trimmed);
  const startsWord = /^\w/.test(trimmed);
  const endsWord = /\w$/.test(trimmed);
  return new RegExp((startsWord ? "\\b" : "") + escaped + (endsWord ? "\\b" : ""), "gi");
}
function words(text) {
  return String(text || "").toLowerCase().match(/[a-z']+/g) || [];
}
function isEcho(line, sentText) {
  const inputTrimmed = String(sentText || "").trim();
  if (!inputTrimmed) return false;
  const lineStr = String(line || "");

  // Word-boundaried, not a raw substring search — a plain indexOf would
  // match "k" inside "locked" for a one-letter input like "k".
  const verbatimRe = echoPattern(inputTrimmed);
  if (verbatimRe && verbatimRe.test(lineStr)) return true;

  const inputWords = words(inputTrimmed);
  if (inputWords.length) {
    const lineWords = words(lineStr);
    let matched = 0;
    let cursor = 0;
    for (let i = 0; i < inputWords.length; i++) {
      const idx = lineWords.indexOf(inputWords[i], cursor);
      if (idx !== -1) { matched++; cursor = idx + 1; }
    }
    if (matched > inputWords.length / 2) return true;
  }

  const re = echoPattern(sentText);
  return !!re && wordCount(lineStr.replace(re, " ")) < 3;
}

// A question in the input ("did you get my text", "you free tonight?")
// calls for a ruder/truer version of the SAME sender asking it again — not
// the recipient's answer standing in for a punchline. Trailing "?" catches
// most; the question-word list catches phrasing that drops it ("did you
// get my text"). A "you"-led yes/no question with no "?" and no question
// word ("you around later") isn't caught — deliberately narrow, per spec,
// not an attempt at exhaustive question detection.
const QUESTION_START_RE = /^(who|what|when|where|why|how|is|are|was|were|do|does|did|can|could|will|would|should|have|has|had)\b/i;
function isQuestionInput(sentText) {
  const t = String(sentText || "").trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return QUESTION_START_RE.test(t);
}

// Openers that read as the question being resolved rather than re-asked —
// "yes", "not really", "i won't" and the like are an answer's shape no
// matter whose mouth it's coming from. Only checked when the input itself
// was a question; on a statement input these same words are just how a
// line starts. Curly apostrophe normalized to straight first — models
// routinely render "won't" as won’t (see NON_ASCII_RE above), and the
// contractions here need to match either.
const ANSWER_STARTS = ["yes", "no", "yeah", "nope", "sure", "not really", "i'm not", "i am not", "i will", "i won't"];
const ANSWER_START_RE = new RegExp("^(" + ANSWER_STARTS.map(escapeRegExp).join("|") + ")\\b", "i");
function isDirectAnswer(line, sentText) {
  if (!isQuestionInput(sentText)) return false;
  const normalized = String(line || "").trim().replace(/[‘’]/g, "'");
  return ANSWER_START_RE.test(normalized);
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

// The model occasionally prefixes a line with the shape it was asked for
// ("twist: ...") even though the prompt only wants the array of strings.
// Strip it before any filter below sees the line, so the word cap counts
// the actual line and the label itself doesn't get judged as content.
const SHAPE_LABEL_RE = /^(twist|confession|throat|non-sequitur)\s*:\s*/i;
function stripShapeLabel(line) {
  return line.replace(SHAPE_LABEL_RE, "");
}

const WORD_CAP = 14;
function wordCount(line) {
  return (String(line || "").trim().match(/\S+/g) || []).length;
}

// Drops any line that's over the word cap, that reads like the model leaked
// its instructions, or that's schema placeholder filler. Returns the
// surviving lines plus how many were dropped and why, for diagnostics.
function filterLines(lines, sentText) {
  const kept = [];
  let droppedWords = 0;
  let droppedSuspicious = 0;
  let droppedCrutch = 0;
  let droppedWall = 0;
  let droppedAscii = 0;
  let droppedEcho = 0;
  let droppedAnswer = 0;
  (lines || []).forEach(function (raw) {
    const line = stripShapeLabel(String(raw).trim());
    if (!line) return;
    if (wordCount(line) > WORD_CAP) { droppedWords++; return; }
    if (SUSPICIOUS.test(line) || PLACEHOLDER.test(line)) { droppedSuspicious++; return; }
    if (isCrutch(line)) { droppedCrutch++; return; }
    if (isWallLine(line)) { droppedWall++; return; }
    if (isNonAscii(line)) { droppedAscii++; return; }
    if (isEcho(line, sentText)) { droppedEcho++; return; }
    if (isDirectAnswer(line, sentText)) { droppedAnswer++; return; }
    kept.push(line);
  });
  return {
    kept: kept,
    droppedWords: droppedWords,
    droppedSuspicious: droppedSuspicious,
    droppedCrutch: droppedCrutch,
    droppedWall: droppedWall,
    droppedAscii: droppedAscii,
    droppedEcho: droppedEcho,
    droppedAnswer: droppedAnswer
  };
}

// Turns a filterLines() result into a short per-filter breakdown for `why`
// — e.g. "words 3, wall 2, echo 1" — instead of a flat "all N filtered"
// that hides which rule actually did it. Order matches the check order in
// filterLines; zero-count filters are omitted.
const DROP_LABELS = [
  ["droppedWords", "words"],
  ["droppedSuspicious", "suspicious"],
  ["droppedCrutch", "crutch"],
  ["droppedWall", "wall"],
  ["droppedAscii", "ascii"],
  ["droppedEcho", "echo"],
  ["droppedAnswer", "answer"]
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
  CRUTCH_WORD_RE,
  isCrutch,
  WALL_WORDS,
  isWallLine,
  NON_ASCII_RE,
  isNonAscii,
  isEcho,
  QUESTION_START_RE,
  isQuestionInput,
  ANSWER_STARTS,
  isDirectAnswer,
  describeDrops,
  SHAPE_LABEL_RE,
  stripShapeLabel,
  WORD_CAP,
  wordCount
};

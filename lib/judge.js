// lib/judge.js
//
// A second, small model call reviewing lines from one generation, after
// lib/postprocess.js's keyword wall (now just slurs and minor-related
// terms — see WALL_WORDS there) has already run. Where a keyword can only
// match/not-match, this catches the things that actually need judgment: is
// this line cruel about the recipient's body/race/disability/mental
// health/family, or hyperbole ("i'd die") that only reads that way to a
// keyword scanner? Does it involve a minor sexually? Does it read as a real
// threat, or a violence joke that's clearly not one?
//
// One call PER LINE, not one call reviewing all six together — a batched
// call let the "be permissive" framing bleed across lines (a genuinely bad
// line sitting next to five mild ones sometimes got waved through with
// them). Judging each line in isolation is what actually holds every line
// to the same bar regardless of what else was in the batch. All the lines
// from one generation fire in parallel via Promise.all, so the wall-clock
// cost stays close to one call's latency, not six calls' worth serially.
//
// Deliberately its own thing, not routed through lib/llm.js's callLLM:
// different prompt shape (a review question, not a generation prompt),
// and a much shorter timeout — this call sits in the response path, so it
// can't afford callLLM's 12s budget. Each line's call has its own 3s
// timeout; a line whose call fails (timeout, network error, non-2xx,
// unparsable reply) is kept — fail open, same as the whole-judge failure
// this replaces did.
const { fetch, Agent } = require("undici");

const BASE_URL = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const CHAT_URL = BASE_URL + "/chat/completions";
const TIMEOUT_MS = 3000;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "mistralai/mistral-small-2603";

const dispatcher = new Agent({
  connect: { timeout: TIMEOUT_MS },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS
});

// Retuned toward permissive (see the "Be permissive..." lead) after the
// first version came back over-eager on ordinary mean-about-the-situation
// lines. The lead paragraph is the operative rubric now — including the
// "pasted text sets the floor" allowance (if the sender's own words already
// went there, the draft continuing in the same register isn't the thing to
// flag) and the hairline-joke-vs-"disgusting fat pig" example of where
// body-shaming actually crosses into attack. The original "This is an 18+
// comedy app..." paragraph stays after it for the output contract (the
// hyperbole examples, the JSON-array-of-numbers reply format) — kept
// verbatim rather than rewritten so this stays a prepend, not a rewrite.
const JUDGE_QUESTION = "Be permissive. This app is meant to be brutal and " +
  "crude; when in doubt, allow. The pasted text sets the floor — if the " +
  "sender's own words already mock someone's looks or situation, " +
  "continuing in the same register is fine. Only flag: slurs or cruelty " +
  "about race, disability, or mental illness; sexual content involving a " +
  "minor; a credible threat against a real person; or body-shaming that " +
  "reads as a genuine attack rather than a joke (a hairline joke is a " +
  "joke; \"you're a disgusting fat pig\" is an attack). " +
  "This is an 18+ comedy app. Crude, profane, sexual, and " +
  "cruel-about-the-situation lines are fine. Answer with the numbers of any " +
  "line that does one of these: targets someone's body, race, disability, " +
  "mental health, or family with cruelty; involves a minor sexually; or " +
  "reads as a credible threat against a real person. Hyperbole like \"i'd " +
  "die\" or \"you're killing me\" is fine. Reply with a JSON array of " +
  "numbers, or [] if none.";

// Still takes an array (kept generic, and it's what extractNumbers'
// JSON-array-of-numbers reply format expects to number against) — but
// judgeOneLine below only ever calls it with a single-line array, so every
// real request reads "1. <line>\n\n<question>" and gets back [1] or [].
function buildJudgeRequest(lines) {
  const numbered = lines.map(function (line, i) { return (i + 1) + ". " + line; }).join("\n");
  return {
    model: JUDGE_MODEL,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: "user", content: numbered + "\n\n" + JUDGE_QUESTION }
    ]
  };
}

// Same tolerant-of-fences-and-commentary extraction as lib/postprocess.js's
// extractArray, but for a flat array of line numbers instead of draft
// objects, and returning null (not []) on anything unparsable — the caller
// needs to tell "judge said nothing's wrong" apart from "judge failed."
// Non-integer or non-positive entries are dropped rather than failing the
// whole parse; a judge hallucinating "2.5" shouldn't void a real verdict.
function extractNumbers(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map(function (n) { return Number(n); })
      .filter(function (n) { return Number.isInteger(n) && n > 0; });
  } catch (e) {
    return null;
  }
}

// Judges a single line. Returns true (flag it), false (judge cleared it),
// or null (the call failed — timeout, network error, non-2xx, or a reply
// with no parseable JSON array) — null is the fail-open signal: the caller
// treats it exactly like false, but judgeLines below still counts it
// separately so api/draft.js can say how many calls actually failed.
async function judgeOneLine(apiKey, line) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://almostsent.app",
        "X-Title": "almost sent"
      },
      body: JSON.stringify(buildJudgeRequest([line])),
      signal: controller.signal,
      dispatcher: dispatcher
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.error) return null;
    const choice = data && data.choices && data.choices[0];
    let text = choice && choice.message && choice.message.content;
    if (Array.isArray(text)) {
      text = text.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    const numbers = extractNumbers(text);
    if (!numbers) return null;
    return numbers.indexOf(1) !== -1;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reviews `lines` (plain strings, already past the keyword wall), one
// per-line judge call fired in parallel via Promise.all so the total wait
// is close to one call's latency rather than lines.length calls' worth.
// Returns { flagged, failedCount }: `flagged` is the 1-based indexes the
// judge actually flagged; `failedCount` is how many of the calls failed
// and were kept open rather than judged — reported in api/draft.js's `why`
// so a run of failures is visible without looking like a clean "0 dropped"
// verdict.
async function judgeLines(apiKey, lines) {
  if (!lines || !lines.length) return { flagged: [], failedCount: 0 };
  const verdicts = await Promise.all(
    lines.map(function (line) { return judgeOneLine(apiKey, line); })
  );
  const flagged = [];
  let failedCount = 0;
  verdicts.forEach(function (verdict, i) {
    if (verdict === null) { failedCount++; return; }
    if (verdict === true) flagged.push(i + 1);
  });
  return { flagged: flagged, failedCount: failedCount };
}

// Applies a judge verdict (1-based indexes into `kept`) to a filterLines()
// result. Mutates `all` in place (each call's `all` array is freshly built
// per-request, never shared) rather than pushing new entries — a
// judge-flagged line already has a dropped:false entry in `all` from
// filterLines, so this flips it to dropped:true/filter:"judge" instead of
// leaving a duplicate.
//
// Relies on one invariant from filterLines: for every item it keeps, the
// push to `kept` and the push to `all` happen in the same loop iteration,
// in the same order — so the Nth non-dropped entry in `all` is always
// `kept[N-1]`. That's what lets `keptIndex` below walk both in lockstep
// without needing to match on line text.
function applyJudgeVerdict(kept, all, flaggedIndexes) {
  const flagged = {};
  (flaggedIndexes || []).forEach(function (n) { flagged[n] = true; });
  let keptIndex = 0;
  (all || []).forEach(function (entry) {
    if (entry.dropped) return;
    keptIndex++;
    if (flagged[keptIndex]) {
      entry.dropped = true;
      entry.filter = "judge";
    }
  });
  const survivors = (kept || []).filter(function (item, i) { return !flagged[i + 1]; });
  return { kept: survivors, all: all, droppedJudge: (kept || []).length - survivors.length };
}

module.exports = {
  judgeLines,
  judgeOneLine,
  applyJudgeVerdict,
  buildJudgeRequest,
  extractNumbers,
  JUDGE_MODEL,
  JUDGE_QUESTION,
  TIMEOUT_MS
};

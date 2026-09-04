// lib/judge.js
//
// A second, small model call that reviews all the lines from one generation
// together, after lib/postprocess.js's keyword wall (now just slurs and
// minor-related terms — see WALL_WORDS there) has already run. Where a
// keyword can only match/not-match, this catches the things that actually
// need judgment: is this line cruel about the recipient's body/race/
// disability/mental health/family, or hyperbole ("i'd die") that only reads
// that way to a keyword scanner? Does it involve a minor sexually? Does it
// read as a real threat, or a violence joke that's clearly not one?
//
// Deliberately its own thing, not routed through lib/llm.js's callLLM:
// different prompt shape (a review question, not a generation prompt),
// and a much shorter timeout — this call sits in the response path, so it
// can't afford callLLM's 12s budget. A judge failure (timeout, network
// error, unparsable reply) is never fatal: api/draft.js falls back to
// whatever survived the keyword wall, unjudged.
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

const JUDGE_QUESTION = "This is an 18+ comedy app. Crude, profane, sexual, and " +
  "cruel-about-the-situation lines are fine. Answer with the numbers of any " +
  "line that does one of these: targets someone's body, race, disability, " +
  "mental health, or family with cruelty; involves a minor sexually; or " +
  "reads as a credible threat against a real person. Hyperbole like \"i'd " +
  "die\" or \"you're killing me\" is fine. Reply with a JSON array of " +
  "numbers, or [] if none.";

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

// Reviews `lines` (plain strings, already past the keyword wall) and
// returns the 1-based indexes the judge flagged for dropping. Never throws
// — a timeout (AbortController, 3s), a non-2xx response, a network error,
// or a reply with no parseable JSON array all come back as null, which
// api/draft.js treats as "judge unavailable, keep the keyword-filtered set
// as-is" rather than as "judge found nothing" (that's a real []).
async function judgeLines(apiKey, lines) {
  if (!lines || !lines.length) return [];
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
      body: JSON.stringify(buildJudgeRequest(lines)),
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
    // Clamp to the actual line count — a judge hallucinating a number past
    // the batch it was given shouldn't reach past this call's own lines.
    return numbers.filter(function (n) { return n <= lines.length; });
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Applies a judge verdict (1-based indexes into `kept`, or null for "judge
// unavailable") to a filterLines() result. Mutates `all` in place (each
// call's `all` array is freshly built per-request, never shared) rather
// than pushing new entries — a judge-flagged line already has a
// dropped:false entry in `all` from filterLines, so this flips it to
// dropped:true/filter:"judge" instead of leaving a duplicate.
//
// Relies on one invariant from filterLines: for every item it keeps, the
// push to `kept` and the push to `all` happen in the same loop iteration,
// in the same order — so the Nth non-dropped entry in `all` is always
// `kept[N-1]`. That's what lets `keptIndex` below walk both in lockstep
// without needing to match on line text.
function applyJudgeVerdict(kept, all, flaggedIndexes) {
  if (!flaggedIndexes) {
    // Judge unavailable — nothing further gets dropped, the keyword-
    // filtered set stands as-is.
    return { kept: kept, all: all, droppedJudge: 0, judgeFailed: true };
  }
  const flagged = {};
  flaggedIndexes.forEach(function (n) { flagged[n] = true; });
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
  return { kept: survivors, all: all, droppedJudge: (kept || []).length - survivors.length, judgeFailed: false };
}

module.exports = {
  judgeLines,
  applyJudgeVerdict,
  buildJudgeRequest,
  extractNumbers,
  JUDGE_MODEL,
  JUDGE_QUESTION,
  TIMEOUT_MS
};

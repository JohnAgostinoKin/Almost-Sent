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

// Rewritten for single-line review with worked examples on both sides
// (OK and FLAG) instead of a rule list alone — the previous version,
// judged with nothing else in the same call to anchor against, gave even
// its own named "disgusting fat pig" example the benefit of the doubt.
// Anchoring the rubric in concrete lines instead of just categories is
// meant to fix that without needing another line in the batch to compare
// against. Output contract also changed: one word, OK or FLAG, not a
// JSON array — there's only ever one line in a request now, so numbering
// was pure overhead. `{text}` is replaced with the actual line at request
// build time (see buildJudgeRequest).
const JUDGE_QUESTION = "You review one line from an 18+ comedy app that " +
  "writes brutal, crude, sexual, profane continuations of text messages. " +
  "Most lines are fine. Answer OK unless the line does one of these: uses " +
  "a slur; is cruel about race, disability, or mental illness; is sexual " +
  "about a minor; is a credible threat against a real person; or " +
  "body-shames as a genuine attack rather than a joke.\n\n" +
  "OK: 'i'd rather fuck a cactus than listen to you breathe' / 'i've " +
  "placed bets on which one names their firstborn after his receding " +
  "hairline' / 'you're the human equivalent of a kick me sign' / 'i hope " +
  "your next text is an emergency so i can ignore it' / 'your mom drove. " +
  "we're engaged.'\n\n" +
  "FLAG: 'you're a disgusting fat pig' / 'go back to your own country' / " +
  "any slur / 'i know where you live and i'm coming tonight' / anything " +
  "sexual involving someone under 18.\n\n" +
  "Line: {text}\n" +
  "Answer OK or FLAG.";

// One line per request now (see JUDGE_QUESTION above) — `line` is spliced
// into the `{text}` placeholder, not numbered into a list.
function buildJudgeRequest(line) {
  return {
    model: JUDGE_MODEL,
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: "user", content: JUDGE_QUESTION.replace("{text}", line) }
    ]
  };
}

// Pulls a FLAG/OK verdict out of the judge's reply. Tolerant of the model
// wrapping the single word in punctuation or a short prefix ("Answer: OK.")
// despite the "Answer OK or FLAG" instruction, via a whole-word search
// rather than an exact-match — but if neither word appears, or (a model
// second-guessing itself mid-reply) both do, this returns null: the same
// "couldn't get a real verdict" signal a network failure would produce,
// which judgeOneLine below treats identically (fail open).
function extractVerdict(raw) {
  if (!raw) return null;
  const text = String(raw);
  const hasFlag = /\bflag\b/i.test(text);
  const hasOk = /\bok(ay)?\b/i.test(text);
  if (hasFlag && !hasOk) return true;
  if (hasOk && !hasFlag) return false;
  return null;
}

// Judges a single line. Returns true (flag it), false (judge cleared it),
// or null (the call failed — timeout, network error, non-2xx, or a reply
// with no clear OK/FLAG in it) — null is the fail-open signal: the caller
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
      body: JSON.stringify(buildJudgeRequest(line)),
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
    return extractVerdict(text);
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
  extractVerdict,
  JUDGE_MODEL,
  JUDGE_QUESTION,
  TIMEOUT_MS
};

// lib/judge.js
//
// A second, small model call reviewing lines from one generation, after
// lib/postprocess.js's keyword wall (now just slurs and minor-related
// terms — see WALL_WORDS there) has already run. Where a keyword can only
// match/not-match, this catches the things that actually need judgment: is
// this line cruel about the recipient's body/race/disability/mental
// health/family, or hyperbole ("i'd die") that only reads that way to a
// keyword scanner? Does it involve a minor sexually? Does it read as a real
// threat, or a violence joke that's clearly not one? Does it encourage
// self-harm given what it's actually replying to?
//
// One call PER LINE, not one call reviewing several together — a batched
// call let the "be permissive" framing bleed across lines (a genuinely bad
// line sitting next to five mild ones sometimes got waved through with
// them). Judging each line in isolation is what actually holds every line
// to the same bar regardless of what else was in the batch. Every line a
// given request needs judged fires in parallel (see api/draft.js's judge
// backfill loop), so the wall-clock cost stays close to one call's
// latency, not each line's worth serially.
//
// Deliberately its own thing, not routed through lib/llm.js's callLLM:
// different prompt shape (a review question, not a generation prompt), and
// a much shorter timeout — this call sits in the response path, so it
// can't afford callLLM's 12s budget. TIMEOUT_MS applies per attempt below,
// not per line — a line can cost up to two attempts (see judgeOneLine).
const { fetch, Agent } = require("undici");

const BASE_URL = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const CHAT_URL = BASE_URL + "/chat/completions";
// Lowered from 3000 — seen timing out on consecutive requests in
// production and falling all the way to fail-open with nothing else tried.
// 2s is still generous for a one-word verdict; what changes is that a
// timeout now means "try the other model" instead of "give up".
const TIMEOUT_MS = 2000;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "mistralai/mistral-small-2603";
// Not env-configurable on purpose — this is specifically a different model
// from JUDGE_MODEL (a different provider, ideally, so a single upstream
// having a bad day doesn't take out both attempts), tried exactly once,
// only after the primary model's own attempt has already failed.
const JUDGE_FALLBACK_MODEL = "openai/gpt-5.4-nano";

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
// was pure overhead.
//
// Judges the FULL composed exchange now — the text someone received,
// immediately followed by the continuation, exactly as lib/compose.js
// would render it (see api/draft.js, which builds this) — not the
// continuation in isolation. A line that reads as a mild non-sequitur
// alone can read as something else entirely once it's clear what it's
// actually replying to; the self-harm criterion below specifically needs
// that context to mean anything ("good riddance then" alone is nothing —
// after "i don't want to be here anymore" it's not). `{text}` is replaced
// with that composed exchange at request build time (see
// buildJudgeRequest).
const JUDGE_QUESTION = "You review one text exchange from an 18+ comedy app: " +
  "a message someone received, immediately followed by the brutal, crude, " +
  "sexual, profane reply they almost sent back but didn't. Judge the REPLY " +
  "— the part after the received message — in light of what it's actually " +
  "replying to. Most replies are fine. Answer OK unless the reply does one " +
  "of these: uses a slur; is cruel about race, disability, or mental " +
  "illness; is sexual about a minor; is a credible threat against a real " +
  "person; is a graphic description of sex acts or genitals — crude " +
  "references and innuendo are fine, explicit description is not; body-" +
  "shames as a genuine attack rather than a joke; attacks someone with " +
  "gendered slurs; or encourages or agrees with self-harm, even jokingly, " +
  "when the received message mentions dying or harm.\n\n" +
  "OK: 'i'd rather fuck a cactus than listen to you breathe' / 'i've " +
  "placed bets on which one names their firstborn after his receding " +
  "hairline' / 'you're the human equivalent of a kick me sign' / 'i hope " +
  "your next text is an emergency so i can ignore it' / 'your mom drove. " +
  "we're engaged.'\n\n" +
  "FLAG: 'you're a disgusting fat pig' / 'go back to your own country' / " +
  "any slur / 'i know where you live and i'm coming tonight' / anything " +
  "sexual involving someone under 18 / a received message mentioning " +
  "dying or self-harm answered with agreement, encouragement, or a joke " +
  "at its expense instead of ignoring or deflecting it / 'kill me now, my " +
  "wifi is out. do it on camera. i'll pay for the data' / 'kill me now, my " +
  "wifi is out. do it properly this time' — the received line being " +
  "obvious hyperbole doesn't matter; the reply still isn't allowed to " +
  "build on it.\n\n" +
  "Exchange: {text}\n" +
  "Answer OK or FLAG.";

// `model` picks which model this particular attempt uses — judgeOneLine
// below is what decides which one that is per attempt.
function buildJudgeRequest(text, model) {
  return {
    model: model || JUDGE_MODEL,
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: "user", content: JUDGE_QUESTION.replace("{text}", text) }
    ]
  };
}

// Pulls a FLAG/OK verdict out of the judge's reply. Tolerant of the model
// wrapping the single word in punctuation or a short prefix ("Answer: OK.")
// despite the "Answer OK or FLAG" instruction, via a whole-word search
// rather than an exact-match — but if neither word appears, or (a model
// second-guessing itself mid-reply) both do, this returns null: the same
// "couldn't get a real verdict" signal a network failure produces, which
// judgeCallOnce/judgeOneLine below treat identically (retry, then fail
// open).
function extractVerdict(raw) {
  if (!raw) return null;
  const text = String(raw);
  const hasFlag = /\bflag\b/i.test(text);
  const hasOk = /\bok(ay)?\b/i.test(text);
  if (hasFlag && !hasOk) return true;
  if (hasOk && !hasFlag) return false;
  return null;
}

// One attempt, one model, no retry logic — judgeOneLine below is what
// chains two of these together. Returns { verdict, latencyMs }: verdict is
// true/false/null (null covers timeout, network error, non-2xx, and an
// unparsable reply alike — all the same "this attempt didn't produce a
// real answer" signal); latencyMs times just this attempt, always, even on
// failure, so a timed-out attempt still reports how long it waited before
// giving up.
async function judgeCallOnce(apiKey, text, model) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://almostsent.app",
        "X-Title": "almost sent"
      },
      body: JSON.stringify(buildJudgeRequest(text, model)),
      signal: controller.signal,
      dispatcher: dispatcher
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { verdict: null, latencyMs: latencyMs };
    const data = await res.json();
    if (data && data.error) return { verdict: null, latencyMs: latencyMs };
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    return { verdict: extractVerdict(content), latencyMs: latencyMs };
  } catch (err) {
    return { verdict: null, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Judges one full exchange (see JUDGE_QUESTION above — `text` should
// already be the composed sent+continuation, not the continuation alone).
// Tries JUDGE_MODEL first; only if that attempt comes back null (timeout,
// network error, non-2xx, or an unparsable reply — anything that isn't a
// real OK/FLAG) does it retry once, with JUDGE_FALLBACK_MODEL, before
// truly failing open. A consecutive run of timeouts on one model no longer
// means every line in that run goes unjudged — it means the OTHER model
// judges them instead.
//
// Returns { verdict, model, latencyMs, retried }: verdict is true (flag
// it), false (cleared), or null (both attempts failed — the caller treats
// this exactly like false, fail open, but still counts it separately so
// api/draft.js can say how many calls actually failed). `model` is whichever
// model actually produced the returned verdict (or, on a double failure,
// whichever model answered last — JUDGE_FALLBACK_MODEL). `latencyMs` is
// that same attempt's own latency — the failed primary attempt's time
// isn't folded in, so this always reflects "how long the attempt that
// actually decided this took", not a retry's cumulative wait.
async function judgeOneLine(apiKey, text) {
  const first = await judgeCallOnce(apiKey, text, JUDGE_MODEL);
  if (first.verdict !== null) {
    return { verdict: first.verdict, model: JUDGE_MODEL, latencyMs: first.latencyMs, retried: false };
  }
  const second = await judgeCallOnce(apiKey, text, JUDGE_FALLBACK_MODEL);
  return { verdict: second.verdict, model: JUDGE_FALLBACK_MODEL, latencyMs: second.latencyMs, retried: true };
}

// Reviews `lines` (already-composed exchanges, past the keyword wall), one
// per-line judge call fired in parallel via Promise.all so the total wait
// is close to one call's latency rather than lines.length calls' worth.
// Returns { flagged, failedCount }: `flagged` is the 1-based indexes the
// judge actually flagged; `failedCount` is how many came back null (both
// attempts failed) and were kept open rather than judged.
//
// Not currently called by api/draft.js (its own judge-backfill loop calls
// judgeOneLine directly, per candidate, to interleave with diversity
// checking) — kept for any caller that wants a plain "judge this whole
// batch, once" call, same as it's always done.
async function judgeLines(apiKey, lines) {
  if (!lines || !lines.length) return { flagged: [], failedCount: 0 };
  const results = await Promise.all(
    lines.map(function (line) { return judgeOneLine(apiKey, line); })
  );
  const flagged = [];
  let failedCount = 0;
  results.forEach(function (result, i) {
    if (result.verdict === null) { failedCount++; return; }
    if (result.verdict === true) flagged.push(i + 1);
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
  judgeCallOnce,
  applyJudgeVerdict,
  buildJudgeRequest,
  extractVerdict,
  JUDGE_MODEL,
  JUDGE_FALLBACK_MODEL,
  JUDGE_QUESTION,
  TIMEOUT_MS
};

// lib/judge.js — v3: two judges, two jobs.
//
// judgeOneLine (below) is SAFETY only — is this line cruel about the
// recipient's body/race/disability/mental health/family, or hyperbole that
// only reads that way to a keyword scanner? Does it involve a minor
// sexually? Does it read as a real threat? Does it encourage self-harm
// given what it's actually replying to? Cheap model (SAFETY_MODEL), one
// call PER CANDIDATE so a genuinely bad line next to mild ones can't get
// waved through by "be permissive" framing bleeding across a batch (see
// api/draft.js's handler, which fires every safety call in parallel).
//
// judgeCandidates (further down) is TASTE — is this actually a good joke?
// v2 had no separate answer to that question; a mechanical "connection
// test" (now retired — see lib/legacy/judge-v2.js) was the closest thing,
// and the safety judge above ended up doing double duty as a taste judge
// by omission. judgeCandidates is the real answer: ONE call reviewing every
// safety-cleared candidate from BOTH generator calls together, checking
// five hard gates (does it actually continue their message, is the
// claimed anchor real and load-bearing, is there a turn, is it clear) and
// then scoring only the survivors — because taste needs to compare
// candidates against each other the safety check never did, and gating
// before scoring is what stops a candidate that merely SOUNDS like a joke
// from ever reaching the scoring formula at all. Runs on the expensive
// model (TASTE_MODEL) — see api/draft.js's handler for where these two
// stages actually combine, and its own header comment for why safety runs
// first, on every candidate, and taste runs once, only on what's left.
const { fetch, Agent } = require("undici");
const { composeDraft } = require("./compose");

const BASE_URL = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const CHAT_URL = BASE_URL + "/chat/completions";

// --- safety judge (unchanged from v2 apart from its env var/constant
// names — SAFETY_MODEL/SAFETY_FALLBACK_MODEL, not JUDGE_MODEL, now that
// JUDGE_MODEL means the taste judge below) -----------------------------

// Lowered from 3000 — seen timing out on consecutive requests in
// production and falling all the way to fail-open with nothing else tried.
// 2s is still generous for a one-word verdict; what changes is that a
// timeout now means "try the other model" instead of "give up".
const SAFETY_TIMEOUT_MS = 2000;
const SAFETY_MODEL = process.env.SAFETY_MODEL || "mistralai/mistral-small-2603";
// Not env-configurable on purpose — this is specifically a different model
// from SAFETY_MODEL (a different provider, ideally, so a single upstream
// having a bad day doesn't take out both attempts), tried exactly once,
// only after the primary model's own attempt has already failed.
const SAFETY_FALLBACK_MODEL = "openai/gpt-5.4-nano";

const safetyDispatcher = new Agent({
  connect: { timeout: SAFETY_TIMEOUT_MS },
  headersTimeout: SAFETY_TIMEOUT_MS,
  bodyTimeout: SAFETY_TIMEOUT_MS
});

// Rewritten for single-line review with worked examples on both sides
// (OK and FLAG) instead of a rule list alone — a version judged with
// nothing else in the same call to anchor against gave even its own named
// "disgusting fat pig" example the benefit of the doubt. Anchoring the
// rubric in concrete lines instead of just categories is meant to fix that
// without needing another line in the batch to compare against. Output
// contract is one word, OK or FLAG — there's only ever one line in a
// request, so numbering is pure overhead.
//
// Judges the FULL composed exchange now — the text someone received,
// immediately followed by the continuation, exactly as lib/compose.js
// would render it — not the continuation in isolation. A line that reads
// as a mild non-sequitur alone can read as something else entirely once
// it's clear what it's actually replying to; the self-harm criterion below
// specifically needs that context to mean anything ("good riddance then"
// alone is nothing — after "i don't want to be here anymore" it's not).
// `{text}` is replaced with that composed exchange at request build time.
const SAFETY_QUESTION = "You review one text exchange from an 18+ comedy app: " +
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

function buildSafetyRequest(text, model) {
  return {
    model: model || SAFETY_MODEL,
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: "user", content: SAFETY_QUESTION.replace("{text}", text) }
    ]
  };
}

// Pulls a FLAG/OK verdict out of the judge's reply. Tolerant of the model
// wrapping the single word in punctuation or a short prefix ("Answer: OK.")
// via a whole-word search rather than an exact-match — but if neither word
// appears, or (a model second-guessing itself mid-reply) both do, this
// returns null: the same "couldn't get a real verdict" signal a network
// failure produces.
function extractSafetyVerdict(raw) {
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
// unparsable reply alike).
async function safetyCallOnce(apiKey, text, model) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, SAFETY_TIMEOUT_MS);
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
      body: JSON.stringify(buildSafetyRequest(text, model)),
      signal: controller.signal,
      dispatcher: safetyDispatcher
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
    return { verdict: extractSafetyVerdict(content), latencyMs: latencyMs };
  } catch (err) {
    return { verdict: null, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Judges one full exchange (`text` should already be the composed
// sent+continuation, not the continuation alone — see composeDraft). Tries
// SAFETY_MODEL first; only if that attempt comes back null (timeout,
// network error, non-2xx, or an unparsable reply) does it retry once, with
// SAFETY_FALLBACK_MODEL, before truly failing open.
//
// Returns { verdict, model, latencyMs, retried }: verdict is true (flag
// it), false (cleared), or null (both attempts failed — the caller treats
// this exactly like false, fail open, but still counts it separately).
async function judgeOneLine(apiKey, text) {
  const first = await safetyCallOnce(apiKey, text, SAFETY_MODEL);
  if (first.verdict !== null) {
    return { verdict: first.verdict, model: SAFETY_MODEL, latencyMs: first.latencyMs, retried: false };
  }
  const second = await safetyCallOnce(apiKey, text, SAFETY_FALLBACK_MODEL);
  return { verdict: second.verdict, model: SAFETY_FALLBACK_MODEL, latencyMs: second.latencyMs, retried: true };
}

// --- taste judge (new in v3) --------------------------------------------

// Expensive on purpose — this is the one call per request that decides
// which three lines a visitor actually sees, so it gets the model worth
// paying for. No fallback model on failure the way safety has one: a
// failed safety call has a real cost (a bad line could ship), a failed
// taste call doesn't — api/draft.js falls back to a fixed lane-priority
// order instead of spending a second expensive call chasing the same
// verdict.
const TASTE_MODEL = process.env.JUDGE_MODEL || "openai/gpt-5.6-sol";
const TASTE_TIMEOUT_MS = 8000;

const tasteDispatcher = new Agent({
  connect: { timeout: TASTE_TIMEOUT_MS },
  headersTimeout: TASTE_TIMEOUT_MS,
  bodyTimeout: TASTE_TIMEOUT_MS
});

// The five hard gates, in the order they're asked — any single NO
// eliminates the candidate before it ever reaches scoring. Named to match
// the JSON keys the prompt asks the model to return under each
// candidate's "gates" object.
const GATE_KEYS = ["continues", "anchor_present", "anchor_load_bearing", "turn", "clear"];
// The seven 0-10 criteria scored only for gate survivors. cliche and
// randomness are the two criteria where a HIGHER number is worse — see
// computeTotal below, which is what actually applies that sign, not the
// model.
const SCORE_KEYS = ["relevance", "surprise", "laugh", "share", "shock", "cliche", "randomness"];

function buildTasteJudgeRequest(sentText, candidates, model) {
  const list = candidates.map(function (c, i) {
    return (i + 1) + ". [lane: " + c.lane + "] anchor: \"" + c.anchor + "\" | mechanism: \"" + c.mechanism + "\"\n" +
      "   \"" + composeDraft(sentText, c.text) + "\"";
  }).join("\n\n");

  const content = "You review " + candidates.length + " candidate replies to a text message, from an app " +
    "that writes the reply someone almost sent back but didn't. Each candidate already claims an ANCHOR " +
    "— the specific word or phrase in the original text its punchline turns on — and a MECHANISM, a few " +
    "words on how. Your job is checking that claim, not taking it on faith, then scoring what actually " +
    "earns it.\n\n" +
    "For each candidate, first check five gates. Any single NO eliminates it — do not score an eliminated " +
    "candidate.\n" +
    "1. continues — does it grammatically continue the SENDER's own message, same person, same tense (not " +
    "answer or reply to it as if it were a separate message)?\n" +
    "2. anchor_present — does the candidate's own stated anchor actually appear in the original text?\n" +
    "3. anchor_load_bearing — does the punchline depend on that anchor — would it collapse into something " +
    "generic if the anchor were removed or swapped for an unrelated word?\n" +
    "4. turn — is there an actual turn (a reveal, reversal, or implication), not just an addition or a " +
    "restatement?\n" +
    "5. clear — is it immediately understandable on one read, no re-reading required?\n\n" +
    "For every candidate that clears all five gates, score 0-10 (integers) on:\n" +
    "relevance (how specifically the line turns on the anchor, not just crude in general), surprise, " +
    "laugh (how funny it actually is), share (how likely someone screenshots this), shock (how loud or " +
    "transgressive it is), cliche (how much it reads like generic internet-roast language — HIGHER means " +
    "MORE cliché, which is worse), randomness (how interchangeable it would be as a reply to a completely " +
    "different message — HIGHER means MORE interchangeable, which is worse).\n\n" +
    "Original text: \"" + sentText + "\"\n\n" +
    "Candidates:\n" + list + "\n\n" +
    "Return ONLY this JSON, one entry per candidate, in input order, \"index\" 1-based matching the numbers " +
    "above:\n" +
    "{\"candidates\":[{\"index\":1,\"gates\":{\"continues\":true,\"anchor_present\":true," +
    "\"anchor_load_bearing\":true,\"turn\":true,\"clear\":true},\"eliminated\":false," +
    "\"scores\":{\"relevance\":0,\"surprise\":0,\"laugh\":0,\"share\":0,\"shock\":0,\"cliche\":0," +
    "\"randomness\":0}}, ...],\"ranked\":[<surviving indices, best first>]}\n" +
    "An eliminated candidate (any gate false, or \"eliminated\":true) still gets its \"gates\" object but " +
    "omits \"scores\" entirely, and its index never appears in \"ranked\". No markdown, no commentary.";

  return {
    model: model,
    temperature: 0,
    max_tokens: 2500,
    messages: [{ role: "user", content: content }]
  };
}

// Pull a JSON object (not array — extractArray in lib/postprocess.js is
// for the generator calls' arrays) out of a reply that may be wrapped in
// markdown fences or have stray commentary around it.
function extractJudgeObject(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// The scoring formula from the brief, applied here in code rather than
// trusted from the model's own arithmetic (models are unreliable at
// multi-term weighted sums; the per-criterion 0-10 judgments are the part
// worth asking a model for, the arithmetic isn't). Shock's weight (0.5) is
// deliberately the lowest positive one — loud can't win by being loud.
function computeTotal(scores) {
  const s = scores || {};
  return 2 * num(s.relevance) + 2 * num(s.surprise) + 2 * num(s.laugh) +
    num(s.share) + 0.5 * num(s.shock) - 2 * num(s.cliche) - 2 * num(s.randomness);
}

// Reviews every safety-cleared candidate from BOTH generator calls
// together (see api/draft.js's handler) in one call. Returns:
//   { ok: true, ranked: [...candidate objects, best first], details: [...],
//     model, latencyMs }
// or, on any failure (timeout, network error, unparsable reply, or a
// response missing usable gate/score data for every candidate):
//   { ok: false, reason, model, latencyMs }
// — the caller (api/draft.js) falls back to fixed lane order rather than
// retrying; see this file's header comment for why taste gets no retry.
//
// `details` is in the SAME order as `candidates` (not ranked order) — one
// entry per input candidate: { lane, eliminated, killedBy, total, scores }.
// killedBy names the first gate that failed ("continues", "clear", etc.),
// or "no-verdict" if the model's response didn't include a usable entry
// for that candidate at all. This is what api/draft.js logs into `why`
// and the ?debug=1 view — every candidate's total, and the gate that
// killed each eliminated one.
async function judgeCandidates(apiKey, sentText, candidates) {
  if (!candidates || !candidates.length) return { ok: false, reason: "no candidates", model: TASTE_MODEL };
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TASTE_TIMEOUT_MS);
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
      body: JSON.stringify(buildTasteJudgeRequest(sentText, candidates, TASTE_MODEL)),
      signal: controller.signal,
      dispatcher: tasteDispatcher
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, reason: "http " + res.status, model: TASTE_MODEL, latencyMs: latencyMs };
    const data = await res.json();
    if (data && data.error) return { ok: false, reason: "api error: " + (data.error.message || "?"), model: TASTE_MODEL, latencyMs: latencyMs };
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    const parsed = extractJudgeObject(content);
    if (!parsed || !Array.isArray(parsed.candidates)) {
      return { ok: false, reason: choice && choice.finish_reason === "length" ? "hit token limit" : "unparsable", model: TASTE_MODEL, latencyMs: latencyMs };
    }

    const details = candidates.map(function (c, i) {
      const entry = parsed.candidates.filter(function (e) { return e && Number(e.index) === i + 1; })[0];
      if (!entry || !entry.gates) {
        return { lane: c.lane, eliminated: true, killedBy: "no-verdict", total: null, candidate: c };
      }
      const failedGate = GATE_KEYS.filter(function (g) { return entry.gates[g] !== true; })[0];
      if (entry.eliminated === true || failedGate) {
        return { lane: c.lane, eliminated: true, killedBy: failedGate || "eliminated", total: null, candidate: c };
      }
      const total = computeTotal(entry.scores);
      return { lane: c.lane, eliminated: false, killedBy: null, total: total, scores: entry.scores, candidate: c };
    });

    const survivors = details.filter(function (d) { return !d.eliminated; });
    survivors.sort(function (a, b) { return b.total - a.total; });

    return {
      ok: true,
      ranked: survivors.map(function (d) { return d.candidate; }),
      details: details,
      model: TASTE_MODEL,
      latencyMs: latencyMs
    };
  } catch (err) {
    return {
      ok: false,
      reason: (err && /timeout/i.test(err.message || "")) ? "timed out" : ((err && err.message) || "error"),
      model: TASTE_MODEL,
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  judgeOneLine,
  buildSafetyRequest,
  extractSafetyVerdict,
  SAFETY_MODEL,
  SAFETY_FALLBACK_MODEL,
  SAFETY_QUESTION,
  SAFETY_TIMEOUT_MS,
  judgeCandidates,
  buildTasteJudgeRequest,
  extractJudgeObject,
  computeTotal,
  GATE_KEYS,
  SCORE_KEYS,
  TASTE_MODEL,
  TASTE_TIMEOUT_MS
};

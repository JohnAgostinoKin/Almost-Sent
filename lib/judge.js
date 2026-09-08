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
// by omission. judgeCandidates is the real answer: reviews every
// candidate from BOTH generator calls together (split into two parallel
// batches — see TASTE_BATCH_COUNT below), checking five hard gates (does
// it actually continue their message, is the claimed anchor real and
// load-bearing, is there a turn, is it clear) and then scoring only the
// survivors — because taste needs to judge things the safety check never
// touches, and gating before scoring is what stops a candidate that
// merely SOUNDS like a joke from ever reaching the scoring formula at
// all. Runs on the expensive model (TASTE_MODEL).
//
// Safety and taste now run CONCURRENTLY on the same full candidate set —
// see api/draft.js's handler, which fires both at once and only removes
// a safety-flagged candidate from the ranking once both are back, rather
// than gating taste on safety's output first. Neither judge's verdict
// depends on the other's, so there's nothing to lose by not waiting.
const { fetch, Agent } = require("undici");
const { composeDraft } = require("./compose");
const { providerFor } = require("./provider");
// Neither request builder in this file uses lib/reasoning.js's override —
// see its header comment for why a short-answer call (this file's whole
// business) is exactly the shape that override breaks, on any model.

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
// gpt-5.4-nano, not mistral-small — measured at 4.9s across ten parallel
// calls on mistral-small in production, most of a request's whole budget
// spent on safety-judging candidates one at a time. mistral-small is now
// the FALLBACK instead (still a different provider from nano, which is
// the point of having a fallback at all — see below), tried once if nano
// itself fails.
const SAFETY_MODEL = process.env.SAFETY_MODEL || "openai/gpt-5.4-nano";
// Not env-configurable on purpose — this is specifically a different model
// from SAFETY_MODEL (a different provider, ideally, so a single upstream
// having a bad day doesn't take out both attempts), tried exactly once,
// only after the primary model's own attempt has already failed.
const SAFETY_FALLBACK_MODEL = "mistralai/mistral-small-2603";

// connections:20 is the fix for a real production symptom ("safety nano
// at 3.6s for ten calls") that turned out NOT to be rate limiting —
// verified with real calls: two separate 10-parallel-call runs against
// OpenRouter directly, bypassing this dispatcher entirely, came back
// 100% 200s in 422-785ms each, no 429 anywhere. Routed through THIS
// dispatcher at its previous default (undici's Agent defaults to a
// 10-connection pool per origin), one of ten calls reliably had to queue
// for a connection long enough to blow past SAFETY_TIMEOUT_MS and fall
// back to SAFETY_FALLBACK_MODEL — exactly the symptom, with a different
// cause than either hypothesis in the room. A 10-candidate request fires
// exactly 10 concurrent safety calls to this same origin, which is
// precisely that pool's boundary. Confirmed the fix: same real calls
// through an Agent with connections:20 — all ten in 373-522ms, 526ms
// total wall clock, no fallback needed.
const safetyDispatcher = new Agent({
  connect: { timeout: SAFETY_TIMEOUT_MS },
  headersTimeout: SAFETY_TIMEOUT_MS,
  bodyTimeout: SAFETY_TIMEOUT_MS,
  connections: 20
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

// No reasoning override here on purpose — see lib/reasoning.js's header
// comment. A one-word verdict at max_tokens:16 is exactly the small-
// budget shape that made reasoning:{effort:"minimal"} actively break
// gpt-5.4-nano (confirmed with a real call): it burned all 16 tokens on
// reasoning and returned content:null instead of "OK"/"FLAG". Omitting
// the field entirely is what makes this fast and correct, on nano or any
// other model SAFETY_MODEL/SAFETY_FALLBACK_MODEL might be set to.
function buildSafetyRequest(text, model) {
  const m = model || SAFETY_MODEL;
  return {
    model: m,
    temperature: 0,
    max_tokens: 16,
    // For an openai/* model (SAFETY_MODEL's default, gpt-5.4-nano),
    // prefers OpenAI's own endpoint over Azure — see lib/provider.js.
    provider: providerFor(m),
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
// chains two of these together. Returns { verdict, latencyMs, reason }:
// verdict is true/false/null (null covers timeout, network error, non-2xx,
// and an unparsable reply alike); `reason` is null on a real verdict, or a
// string naming exactly what went wrong otherwise — the status code and
// response body for a non-2xx, the finish_reason and raw content for an
// unparsable reply (this is what actually caught gpt-5.4-nano silently
// burning its whole token budget on reasoning and returning content:null
// with finish_reason:"length" — a 200 with nothing usable in it, which
// `!res.ok` alone would never have caught), or the error message for a
// network failure/timeout. judgeOneLine folds this into what it returns so
// api/draft.js can log the actual cause instead of a bare null.
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
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      return { verdict: null, latencyMs: latencyMs, reason: "http " + res.status + ": " + body.slice(0, 300) };
    }
    const data = await res.json();
    if (data && data.error) {
      return { verdict: null, latencyMs: latencyMs, reason: "api error: " + JSON.stringify(data.error).slice(0, 300) };
    }
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    const verdict = extractSafetyVerdict(content);
    if (verdict === null) {
      return {
        verdict: null,
        latencyMs: latencyMs,
        reason: "unparsable (finish_reason=" + (choice && choice.finish_reason) + ", content=" + JSON.stringify(content == null ? content : String(content).slice(0, 100)) + ")"
      };
    }
    return { verdict: verdict, latencyMs: latencyMs, reason: null };
  } catch (err) {
    const isAbort = err && err.name === "AbortError";
    return {
      verdict: null,
      latencyMs: Date.now() - started,
      reason: isAbort ? ("timeout after " + SAFETY_TIMEOUT_MS + "ms") : ("network error: " + (err && err.message))
    };
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
// Returns { verdict, model, latencyMs, retried, reason }: verdict is true
// (flag it), false (cleared), or null (both attempts failed — the caller
// treats this exactly like false, fail open, but still counts it
// separately). `reason` is null only when SAFETY_MODEL's own first
// attempt produced a real verdict outright — it's ALWAYS set the moment
// that first attempt fails, even if the fallback then succeeds, because
// "the primary model keeps failing over" is exactly the signal worth
// surfacing (see api/draft.js's handler, which logs and folds this into
// `why`) — silently succeeding via fallback is how this went unnoticed
// long enough to need diagnosing at all.
async function judgeOneLine(apiKey, text) {
  const first = await safetyCallOnce(apiKey, text, SAFETY_MODEL);
  if (first.verdict !== null) {
    return { verdict: first.verdict, model: SAFETY_MODEL, latencyMs: first.latencyMs, retried: false, reason: null };
  }
  const second = await safetyCallOnce(apiKey, text, SAFETY_FALLBACK_MODEL);
  const reason = second.verdict !== null
    ? SAFETY_MODEL + " failed (" + first.reason + "), fell back to " + SAFETY_FALLBACK_MODEL
    : SAFETY_MODEL + " failed (" + first.reason + "); fallback " + SAFETY_FALLBACK_MODEL + " also failed (" + second.reason + ")";
  return { verdict: second.verdict, model: SAFETY_FALLBACK_MODEL, latencyMs: second.latencyMs, retried: true, reason: reason };
}

// --- taste judge (new in v3) --------------------------------------------

// Meant to be the expensive model worth paying for — this decides which
// three lines a visitor actually sees — but Sol measured 9.2s here in
// production (timing out) even with reasoning:{effort:"minimal"} applied
// (see lib/reasoning.js), so it's gpt-5.4 by default instead, same as
// GENERATOR_MODEL (see lib/prompt.js's own comment on that measurement).
// No fallback model on failure the way safety has one: a failed safety
// call has a real cost (a bad line could ship), a failed taste call
// doesn't — api/draft.js falls back to a fixed lane-priority order
// instead of spending a second call chasing the same verdict.
const TASTE_MODEL = process.env.JUDGE_MODEL || "openai/gpt-5.4";
// Lowered from 8000, then 5000 — a slow model should fail over to the
// fixed lane-order fallback fast, not stall the page waiting on it. Each
// batch normally clears well under this (1.6-2s measured live for a
// 5-candidate batch); 3s is margin for a slow draw, not the expected case.
const TASTE_TIMEOUT_MS = 3000;

const tasteDispatcher = new Agent({
  connect: { timeout: TASTE_TIMEOUT_MS },
  headersTimeout: TASTE_TIMEOUT_MS,
  bodyTimeout: TASTE_TIMEOUT_MS
});

// Every candidate's gates and scores are judged independently of every
// other candidate — nothing in the rubric below compares one candidate
// against another — so splitting the ten into two batches of five and
// judging them in parallel changes nothing about what gets judged, only
// how long it takes to hear back. See judgeCandidates.
const TASTE_BATCH_COUNT = 2;

// The five hard gates, in the order they're asked — any single one
// failing eliminates the candidate before it ever reaches scoring. Named
// to match the gate name the model reports in the compact output format
// below (see buildTasteJudgeRequest).
const GATE_KEYS = ["continues", "anchor_present", "anchor_load_bearing", "turn", "clear"];
// The seven 0-10 criteria scored only for gate survivors, in the exact
// order the compact format reports them. cliche and randomness are the
// two criteria where a HIGHER number is worse — see computeTotal below,
// which is what actually applies that sign, not the model.
const SCORE_KEYS = ["relevance", "surprise", "laugh", "share", "shock", "cliche", "randomness"];

// One line per candidate, nothing else — no prose, no JSON. This replaced
// a JSON schema that spelled out a "gates" object (five booleans) and a
// "scores" object (seven numbers) per candidate in full every time — pure
// output-token cost that was a real part of why the ten-candidate version
// of this call measured 9.2s+ even on a fast model. The compact format
// asks for the exact same judgments for a fraction of the tokens: index,
// then either "0" (cleared every gate) or the name of whichever gate
// failed first, then — only when it cleared — the seven scores as a bare
// comma-separated list.
function buildTasteJudgeRequest(sentText, candidates, model) {
  const list = candidates.map(function (c, i) {
    return (i + 1) + ". [lane: " + c.lane + "] anchor: \"" + c.anchor + "\"\n" +
      "   \"" + composeDraft(sentText, c.text) + "\"";
  }).join("\n\n");

  const content = "You review " + candidates.length + " candidate replies to a text message, from an app " +
    "that writes the reply someone almost sent back but didn't. Each candidate already claims an ANCHOR " +
    "— the specific word or phrase in the original text its punchline turns on. Check that claim, don't " +
    "take it on faith, then score what actually earns it.\n\n" +
    "For each candidate, first check five gates. Any single one failing eliminates the candidate — do not " +
    "score an eliminated candidate.\n" +
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
    "Output EXACTLY one line per candidate, in this order, nothing else — no prose, no headers, no " +
    "markdown, no blank lines, no explanation.\n" +
    "Each line: index|killed_gate_or_0|relevance,surprise,laugh,share,shock,cliche,randomness\n" +
    "- index: the candidate number above, 1-based.\n" +
    "- second field: 0 if it clears all five gates, or the exact name of the FIRST gate that failed " +
    "(continues, anchor_present, anchor_load_bearing, turn, or clear) if eliminated.\n" +
    "- third field: ONLY when the second field is 0 — the seven scores in that exact order, comma-" +
    "separated, no spaces. Omit this field and its leading | entirely for an eliminated candidate.\n\n" +
    "Example, 3 candidates, the second eliminated:\n" +
    "1|0|8,7,9,6,3,2,1\n" +
    "2|anchor_present\n" +
    "3|0|6,9,9,8,1,0,0";

  // No reasoning override — see lib/reasoning.js's header comment. Tested
  // this exact request against gpt-5.4 with reasoning:{effort:"minimal"}
  // set: max_tokens:300 all spent on reasoning, content:null. Omitted
  // entirely: 1.6s, reasoning_tokens:0, a perfectly-formed compact
  // response. The small max_tokens a compact per-batch answer actually
  // needs is exactly what breaks the override here, same as the safety
  // judge above — this isn't a nano-specific quirk.
  return {
    model: model,
    temperature: 0,
    max_tokens: 300,
    // For an openai/* model (TASTE_MODEL's default, gpt-5.4), prefers
    // OpenAI's own endpoint over Azure — see lib/provider.js.
    provider: providerFor(model),
    messages: [{ role: "user", content: content }]
  };
}

// Parses the compact index|gate_or_0|scores format above into a map keyed
// by 1-based index. A line that doesn't parse (wrong field count, a non-
// numeric index, a scores segment that isn't exactly seven numbers) is
// simply absent from the map — judgeBatch below treats a missing index
// exactly like a JSON response that omitted an entry: "no-verdict".
function parseCompactJudgeLines(raw) {
  const byIndex = {};
  if (!raw) return byIndex;
  String(raw).split("\n").forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split("|");
    const index = parseInt(parts[0], 10);
    if (!isFinite(index)) return;
    const gate = (parts[1] || "").trim();
    if (gate !== "0") {
      byIndex[index] = { eliminated: true, killedBy: gate || "unparsable" };
      return;
    }
    const nums = (parts[2] || "").split(",").map(function (s) { return Number(s.trim()); });
    if (nums.length !== SCORE_KEYS.length || nums.some(function (n) { return !isFinite(n); })) {
      byIndex[index] = { eliminated: true, killedBy: "unparsable-scores" };
      return;
    }
    const scores = {};
    SCORE_KEYS.forEach(function (key, i) { scores[key] = nums[i]; });
    byIndex[index] = { eliminated: false, killedBy: null, scores: scores };
  });
  return byIndex;
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

// One batch (up to ~5 candidates), one HTTP call. Returns { ok, details,
// model, latencyMs, reason } — `details` (only on ok:true) is in the SAME
// order as `batch`, one entry per candidate: { lane, eliminated, killedBy,
// total, scores, candidate }. On failure, `reason` names exactly what
// went wrong (status code + body, an API error object, a reply that
// didn't parse as a single valid line, or a timeout/network error) — see
// lib/reasoning.js and this file's safetyCallOnce for the same discipline
// applied to the other judge, which is what actually caught gpt-5.4-nano
// silently returning nothing usable there.
async function judgeBatch(apiKey, sentText, batch) {
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
      body: JSON.stringify(buildTasteJudgeRequest(sentText, batch, TASTE_MODEL)),
      signal: controller.signal,
      dispatcher: tasteDispatcher
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      return { ok: false, reason: "http " + res.status + ": " + body.slice(0, 300), model: TASTE_MODEL, latencyMs: latencyMs };
    }
    const data = await res.json();
    if (data && data.error) {
      return { ok: false, reason: "api error: " + JSON.stringify(data.error).slice(0, 300), model: TASTE_MODEL, latencyMs: latencyMs };
    }
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    const byIndex = parseCompactJudgeLines(content);
    if (!Object.keys(byIndex).length) {
      return {
        ok: false,
        reason: "unparsable (finish_reason=" + (choice && choice.finish_reason) + ", content=" +
          JSON.stringify(content == null ? content : String(content).slice(0, 200)) + ")",
        model: TASTE_MODEL,
        latencyMs: latencyMs
      };
    }

    const details = batch.map(function (c, i) {
      const entry = byIndex[i + 1];
      if (!entry) return { lane: c.lane, eliminated: true, killedBy: "no-verdict", total: null, candidate: c };
      if (entry.eliminated) return { lane: c.lane, eliminated: true, killedBy: entry.killedBy, total: null, candidate: c };
      const total = computeTotal(entry.scores);
      return { lane: c.lane, eliminated: false, killedBy: null, total: total, scores: entry.scores, candidate: c };
    });

    return { ok: true, details: details, model: TASTE_MODEL, latencyMs: latencyMs };
  } catch (err) {
    const isAbort = err && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? ("timeout after " + TASTE_TIMEOUT_MS + "ms") : ("network error: " + (err && err.message)),
      model: TASTE_MODEL,
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

// Splits every safety-cleared candidate from BOTH generator calls (see
// api/draft.js's handler) into TASTE_BATCH_COUNT roughly-even groups and
// judges them in parallel. Returns:
//   { ok: true, ranked: [...candidate objects, best first], details: [...],
//     model, latencyMs }
// or, if ANY batch fails for any reason:
//   { ok: false, reason, model, latencyMs }
// — a partial success (one batch judged fine, another didn't) still
// counts as a failure here rather than judging some candidates and
// guessing at the rest; api/draft.js falls back to fixed lane order for
// all of them in that case, same as any other taste-judge failure. See
// this file's header comment for why taste gets no retry the way safety
// does.
//
// `details` is in the SAME order as `candidates` (each batch's own
// entries concatenated in the order the batches were split, which
// reconstructs the original order) — one entry per input candidate:
// {lane, eliminated, killedBy, total, scores}. killedBy names the first
// gate that failed, "no-verdict" if the model's response didn't cover
// that candidate at all, or "unparsable"/"unparsable-scores" for a
// malformed line. This is what api/draft.js logs into `why` and the
// ?debug=1 view.
async function judgeCandidates(apiKey, sentText, candidates) {
  if (!candidates || !candidates.length) return { ok: false, reason: "no candidates", model: TASTE_MODEL };

  const batchSize = Math.ceil(candidates.length / TASTE_BATCH_COUNT);
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  const started = Date.now();
  const results = await Promise.all(batches.map(function (batch) { return judgeBatch(apiKey, sentText, batch); }));
  const latencyMs = Date.now() - started; // wall-clock across the parallel batches, not their sum

  const failed = results.filter(function (r) { return !r.ok; })[0];
  if (failed) {
    return { ok: false, reason: "batch failed: " + failed.reason, model: TASTE_MODEL, latencyMs: latencyMs };
  }

  const details = [];
  results.forEach(function (r) { details.push.apply(details, r.details); });

  const survivors = details.filter(function (d) { return !d.eliminated; });
  survivors.sort(function (a, b) { return b.total - a.total; });

  return {
    ok: true,
    ranked: survivors.map(function (d) { return d.candidate; }),
    details: details,
    model: TASTE_MODEL,
    latencyMs: latencyMs
  };
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
  judgeBatch,
  buildTasteJudgeRequest,
  parseCompactJudgeLines,
  computeTotal,
  GATE_KEYS,
  SCORE_KEYS,
  TASTE_MODEL,
  TASTE_TIMEOUT_MS,
  TASTE_BATCH_COUNT
};

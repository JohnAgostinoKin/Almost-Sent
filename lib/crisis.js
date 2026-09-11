// lib/crisis.js
//
// A semantic pre-check on the PASTED text itself (not the generated
// output — see lib/judge.js for that), run once per request in parallel
// with generation (see api/draft.js's handler) so it never adds latency on
// the common, non-crisis path.
//
// isHardcodedClear (below MIN_WORDS's own comment) runs before any of
// that, on every call, model included — a request to talk, call, meet, or
// check in is never crisis, full stop, and belongs on a list CRISIS_MODEL
// can't misread rather than a rubric it has to get right every time.
// `npm run crisis-test` (scripts/crisis-test.js) is the regression suite
// that locks both this list and the explicit-crisis phrases it must never
// touch — run it after any change here.
//
// lib/block.js's classifyBlock() already catches explicit terms (kill/
// suicide/rape/minor/stalk) via keyword regex, synchronously, before
// generation even starts — self-harm phrasing there ("kill myself",
// "suicide") already resolves to the same crisis screen this does. This
// exists for what a keyword list structurally can't catch: ambiguous
// phrasing that reads as a real crisis signal to a person — "i don't want
// to be here anymore" — without containing any single flaggable word. When
// this fires, the page shows a plain line with a crisis resource instead of
// a joke (see api/draft.js's handler) — no draft, no reactions, no share.
//
// A DEDICATED moderation model — mistralai/mistral-moderation-2603, the
// brief's first choice — was checked against OpenRouter's own /models list
// (no auth needed) before writing any of this: it isn't there, and no
// model with "moderation" in its id is. That's not a naming mismatch to
// paper over — Mistral's moderation product is a separate, dedicated
// endpoint (POST /v1/moderations) requiring a native Mistral API key,
// architecturally different from the chat/completions models OpenRouter
// proxies, and this app only ever holds an OpenRouter key. So this stays
// on CRISIS_MODEL (mistral-small-2603, temperature 0) with a three-answer
// classification instead of the old binary one — the brief's own fallback
// for exactly this case.
const { fetch, Agent } = require("undici");

const BASE_URL = (process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const CHAT_URL = BASE_URL + "/chat/completions";
const TIMEOUT_MS = 3000;
const CRISIS_MODEL = process.env.CRISIS_MODEL || "mistralai/mistral-small-2603";

const dispatcher = new Agent({
  connect: { timeout: TIMEOUT_MS },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS
});

// Three states, not two — "explicit_crisis" is the old CRISIS bucket
// (kept as close to its original wording/examples as the three-way split
// allows); "ambiguous_distress" is new, for real but less explicit
// distress signals that don't rise to a stated intent; "clear" is the old
// OK bucket. Both explicit_crisis and ambiguous_distress currently route
// to the same 988 screen (see api/draft.js's handler) — logged as
// separate states regardless (see index.html's "safety" event), so the
// split between them is visible even though the two aren't yet treated
// differently.
//
// Deliberately biased toward the more serious state when a message could
// plausibly read either way — a false positive here costs one visitor a
// joke; a false negative is the screenshot that ends the app. Retuned
// after that bias started catching ordinary relationship/breakup language
// ("i can't do this anymore" about a partner, not a life) on the same
// "pick the more serious one" instinct meant for genuine ambiguity about
// whether someone means to hurt themselves. The fix is narrowing WHAT the
// two upper states can be about, not softening the bias itself: both
// ambiguous_distress and explicit_crisis now require the text to actually
// be about the sender's own life, body, existence, dying, disappearing, or
// not being here. Giving up on a relationship, a plan, or a fight — no
// matter how final or dramatic ("i'm done with you," "this is over") — is
// always clear, even under the plausibly-either-way bias; that bias now
// only applies within the life/self-harm register itself (ambiguous vs.
// explicit), never to pull relationship language up into it.
const CRISIS_QUESTION = "You review one pasted text message for whether the " +
  "SENDER (the person who wrote it, not the reader) shows signs of real " +
  "emotional distress or a mental health crisis. Classify it into exactly " +
  "one of three states.\n\n" +
  "clear — ordinary venting, sarcasm, hyperbole, or giving up on a " +
  "relationship, a plan, or a fight — breaking up, walking away, wanting " +
  "to be left alone, being done with a person or a situation. This is " +
  "clear no matter how final or dramatic it sounds, as long as it isn't " +
  "actually about the sender's own life, body, or existence. A request to " +
  "talk, call, or meet is never crisis on its own — 'can we talk,' 'call " +
  "me,' 'are you okay,' asked plainly, are ordinary requests to connect, " +
  "not a crisis signal, however open-ended or short they read.\n" +
  "ambiguous_distress — reads as genuinely upset, hopeless, sad, or " +
  "struggling ABOUT THE SENDER'S OWN LIFE — dying, disappearing, or not " +
  "being here — with no implication, even a hinted or indirect one, that " +
  "they might act on it. Never this state for language about a " +
  "relationship, a plan, or a fight, however final it sounds. A vague " +
  "'this'/'it'/'everything' with no stated subject ('i can't do this " +
  "anymore,' 'i'm done with this') defaults to clear, not " +
  "ambiguous_distress — treat an unnamed 'this' as a situation or " +
  "relationship, not the sender's life, unless the text also names life, " +
  "dying, disappearing, or not being here.\n" +
  "explicit_crisis — a real statement of suicidal intent or self-harm " +
  "about the sender's own life or body, INCLUDING a hint or implication " +
  "rather than the literal words — 'you won't have to worry about me much " +
  "longer,' 'everyone would be better off without me,' and similar " +
  "goodbye-shaped statements about the sender not existing all count here, " +
  "not in ambiguous_distress, even without the words 'suicide' or 'kill " +
  "myself.' Never a relationship ending, no matter how final.\n\n" +
  "When a message is actually about the sender's own life or existence " +
  "and could plausibly read as either ambiguous_distress or " +
  "explicit_crisis, pick the more serious one; the cost of understating a " +
  "real crisis is much higher than the cost of overstating an ordinary " +
  "one. This bias never applies to relationship, plan, or fight language " +
  "— that stays clear regardless of how dramatic it sounds.\n\n" +
  "clear: 'ugh i want to die, this meeting is never ending' / 'i'm so done " +
  "with this job' / 'kill me now, my wifi is out again' / 'i'm fine' / " +
  "'this is the worst day ever' / 'i could just scream' / 'i can't do " +
  "this anymore' / 'i'm done with you' / 'leave me alone' / 'i give up on " +
  "us' / 'this is over' / 'i just want to breathe' / 'i don't know how " +
  "much more of this i can take' / 'can we talk' / 'can we talk?' / " +
  "'please call me' / 'i need to talk' / 'are you okay?' / 'we need to " +
  "talk' / 'call me' / 'can we meet'.\n\n" +
  "ambiguous_distress: 'nothing feels like it matters anymore' / 'i'm so " +
  "tired of everything' / 'i just want to disappear for a while' / " +
  "'everyone would probably be fine without me around as much'.\n\n" +
  "explicit_crisis: 'i don't want to be here anymore' / 'everyone would be " +
  "better off without me' / 'i'm done with everything, for real this " +
  "time, i don't think i can keep going' / 'you won't have to worry about " +
  "me much longer' / 'i want to kill myself'.\n\n" +
  "Text: {text}\n" +
  "Answer with exactly one word: clear, ambiguous_distress, or explicit_crisis.";

// No reasoning override — see lib/reasoning.js's header comment. A one-
// word verdict at max_tokens:16 is exactly the small-budget shape
// confirmed (on lib/judge.js's safety and taste judges — same call
// mechanics, same discipline applies here) to make
// reasoning:{effort:"minimal"} eat the whole budget and return nothing
// usable, on any gpt-5.x model. CRISIS_MODEL defaults to mistral-small
// (no gpt-5.x involved either way today), but this stays correct if
// that's ever changed via env.
function buildCrisisRequest(text) {
  return {
    model: CRISIS_MODEL,
    temperature: 0,
    max_tokens: 16,
    messages: [
      { role: "user", content: CRISIS_QUESTION.replace("{text}", text) }
    ]
  };
}

// Pulls one of the three states out of the model's reply. Tolerant of the
// model wrapping the word in punctuation or a short prefix, same whole-word
// approach as lib/judge.js's extractSafetyVerdict — but with three
// mutually-exclusive candidates instead of two: exactly one of the three
// has to appear (as its own token, not as a substring of one of the
// others — "clear", "ambiguous_distress", and "explicit_crisis" don't
// overlap that way) or this returns null, the same "couldn't get a real
// answer" signal a network failure produces.
function extractVerdict(raw) {
  if (!raw) return null;
  const text = String(raw).toLowerCase();
  const hasExplicit = /\bexplicit_crisis\b/.test(text);
  const hasAmbiguous = /\bambiguous_distress\b/.test(text);
  const hasClear = /\bclear\b/.test(text);
  const hits = (hasExplicit ? 1 : 0) + (hasAmbiguous ? 1 : 0) + (hasClear ? 1 : 0);
  if (hits !== 1) return null;
  if (hasExplicit) return "explicit_crisis";
  if (hasAmbiguous) return "ambiguous_distress";
  return "clear";
}

// Hardcoded CLEAR overrides — checked before the model, before even the
// MIN_WORDS skip below. Bug fix: "can we talk" and "can we talk?" were
// both routing to the 988 screen while "we need to talk" wasn't — the
// classifier read the shorter, open-ended phrasing as MORE ambiguous than
// the longer, more dramatic-sounding one, backwards from what the CRISIS_
// QUESTION rubric intends. A request to talk, call, meet, or check in is
// never crisis on its own, whatever a model call makes of it phrase by
// phrase — these never reach CRISIS_MODEL at all, so there's nothing for
// a model to get wrong here again. Matched against the WHOLE normalized
// text (trimmed, lowercased, trailing .!? stripped), not a substring
// search — a longer message that happens to contain "call me" partway
// through still goes to the model, same as before.
const CLEAR_PATTERNS = [
  /^(please\s+)?call me(\s+(later|back|when you can|please))?$/,
  /^(can|could|should) we (talk|chat|meet|catch up|touch base|check in)(\s+(later|sometime|tonight|tomorrow|soon))?$/,
  /^(i|we) (need|want|have) to talk$/,
  /^(are you|you) (ok|okay|alright|doing ok|doing okay|doing alright)$/,
  /^(can|could) (i|we) (call|meet|see) you(\s+(later|sometime|tonight|tomorrow))?$/,
  /^(let'?s|lets) (talk|chat|meet|catch up|touch base|check in)$/
];
function isHardcodedClear(text) {
  const normalized = String(text || "").trim().toLowerCase().replace(/[.!?]+$/, "");
  return CLEAR_PATTERNS.some(function (re) { return re.test(normalized); });
}

// Below this many words, skip the model call entirely — "k." or "fine"
// can't carry a crisis signal, and this is short enough that the model
// guessing wrong is more likely than a real one slipping through. A false
// positive here (a one-word reply landing on the 988 screen) is a worse
// experience than the true miss it would take to avoid, unlike the
// deliberately trigger-happy bias in CRISIS_QUESTION above, which is
// tuned for the opposite tradeoff on everything longer than this.
const MIN_WORDS = 3;

// Returns { state, crisis }: `state` is "clear" | "ambiguous_distress" |
// "explicit_crisis" | "skipped" (under MIN_WORDS, or an escalation refetch
// — see api/draft.js, which never calls this for either case) | "failed"
// (the call itself failed — timeout, network, non-2xx, unparsable reply).
// `crisis` is the boolean api/draft.js actually routes on: true for both
// explicit_crisis and ambiguous_distress (see this file's header comment
// on why those currently share a routing outcome), false for everything
// else — "failed" and "skipped" both fail open, same convention as v2,
// for the same reason: an infrastructure hiccup or a too-short input
// shouldn't turn into every visitor seeing a crisis message instead of the
// product. `state` (not just `crisis`) is what api/draft.js logs into its
// `safety` event, so failed/skipped calls are still visible in the split,
// not silently folded into "clear".
async function checkCrisis(apiKey, text) {
  if (isHardcodedClear(text)) return { state: "clear", crisis: false };
  if (!apiKey || !text) return { state: "failed", crisis: false };
  const wordCount = String(text).trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS) return { state: "skipped", crisis: false };
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
      body: JSON.stringify(buildCrisisRequest(text)),
      signal: controller.signal,
      dispatcher: dispatcher
    });
    if (!res.ok) return { state: "failed", crisis: false };
    const data = await res.json();
    if (data && data.error) return { state: "failed", crisis: false };
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    const state = extractVerdict(content);
    if (state === null) return { state: "failed", crisis: false };
    return { state: state, crisis: state === "explicit_crisis" || state === "ambiguous_distress" };
  } catch (err) {
    return { state: "failed", crisis: false };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkCrisis, buildCrisisRequest, extractVerdict, isHardcodedClear, CLEAR_PATTERNS, CRISIS_MODEL, CRISIS_QUESTION, TIMEOUT_MS, MIN_WORDS };

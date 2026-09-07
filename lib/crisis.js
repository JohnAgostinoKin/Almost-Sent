// lib/crisis.js
//
// A semantic pre-check on the PASTED text itself (not the generated
// output — see lib/judge.js for that), run once per lead request in
// parallel with generation (see api/draft.js's handler) so it never adds
// latency on the common, non-crisis path.
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

// Deliberately biased toward flagging ambiguous phrasing — a false
// positive here costs one visitor a joke; a false negative is the
// screenshot that ends the app. The examples on both sides exist to keep
// ordinary venting/hyperbole ("kill me now, my wifi is out") from
// tripping this too, not to narrow what counts as a crisis signal.
const CRISIS_QUESTION = "You review one pasted text message for whether the " +
  "SENDER (the person who wrote it, not the reader) sounds like they may be " +
  "in a real mental health crisis or expressing suicidal ideation — even " +
  "phrased indirectly or without any explicit word for it. When in doubt, " +
  "flag it; the cost of missing a real one is much higher than the cost of " +
  "flagging an ordinary message by mistake.\n\n" +
  "NOT a crisis — ordinary venting, sarcasm, or hyperbole: 'ugh i want to " +
  "die, this meeting is never ending' / 'i'm so done with this job' / " +
  "'kill me now, my wifi is out again' / 'i'm fine' / 'this is the worst " +
  "day ever' / 'i could just scream'.\n\n" +
  "CRISIS — even indirect: 'i don't want to be here anymore' / " +
  "'everyone would be better off without me' / 'this is goodbye' / " +
  "'i'm done with everything, for real this time' / 'you won't have to " +
  "worry about me much longer' / 'i can't do this anymore, i mean it' / " +
  "'i want to kill myself'.\n\n" +
  "Text: {text}\n" +
  "Answer CRISIS or OK.";

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

// Tolerant of the model wrapping the word in punctuation or a short prefix,
// same whole-word approach as lib/judge.js's extractSafetyVerdict.
function extractVerdict(raw) {
  if (!raw) return null;
  const text = String(raw);
  const hasCrisis = /\bcrisis\b/i.test(text);
  const hasOk = /\bok(ay)?\b/i.test(text);
  if (hasCrisis && !hasOk) return true;
  if (hasOk && !hasCrisis) return false;
  return null;
}

// Returns true (crisis), false (cleared), or null (the call itself failed
// — timeout, network, non-2xx, unparsable reply). null is treated as "not
// a crisis" by the caller (api/draft.js), same fail-open convention as
// lib/judge.js — an infrastructure hiccup on this one small classification
// call shouldn't turn into every visitor seeing a crisis message instead
// of the product. That's a different question from how the MODEL'S OWN
// judgment handles ambiguity, which is where the "flag it when in doubt"
// bias above actually does its work — a real response from the model, not
// a failure to get one, is what's expected to catch the ambiguous cases.
// Below this many words, skip the model call entirely — "k." or "fine"
// can't carry a crisis signal, and this is short enough that the model
// guessing wrong is more likely than a real one slipping through. A false
// positive here (a one-word reply landing on the 988 screen) is a worse
// experience than the true miss it would take to avoid, unlike the
// deliberately trigger-happy bias in CRISIS_QUESTION above, which is
// tuned for the opposite tradeoff on everything longer than this.
const MIN_WORDS = 3;

async function checkCrisis(apiKey, text) {
  if (!apiKey || !text) return null;
  const wordCount = String(text).trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS) return null;
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
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.error) return null;
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    return extractVerdict(content);
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkCrisis, buildCrisisRequest, extractVerdict, CRISIS_MODEL, CRISIS_QUESTION, TIMEOUT_MS, MIN_WORDS };

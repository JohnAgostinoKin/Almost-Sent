// Safety and impact are separate judgments. Adult roast hyperbole, profanity,
// ordinary family jokes and personal cuts are allowed; concrete unsafe content
// stays blocked. Impact measures the owner's opt-in roast target, not politeness
// or laughter alone. Judge the same sender's full message throughout.
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

// SAFETY_MODEL's own timeout. Lowered from 3000 to 2000 once (a timeout
// there used to mean "give up," and fail-open shipped unjudged lines),
// then raised back to 3000 for the primary only: at 2s nano was timing out
// often enough under load that lines were failing open (or leaning on the
// fallback) that a slightly longer wait would have judged directly. The
// FALLBACK keeps its own, shorter 2s ceiling — it only ever runs after the
// primary has already burned its 3s, so a double failure costs at most 5s,
// not 6.
const SAFETY_TIMEOUT_MS = 3000;
const SAFETY_FALLBACK_TIMEOUT_MS = 2000;
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
// Socket-level timeouts sized to the longer of the two per-call ceilings;
// each call's own AbortController (safetyCallOnce) is what enforces its
// actual limit.
const SAFETY_SOCKET_TIMEOUT_MS = Math.max(SAFETY_TIMEOUT_MS, SAFETY_FALLBACK_TIMEOUT_MS);
const safetyDispatcher = new Agent({
  connect: { timeout: SAFETY_SOCKET_TIMEOUT_MS },
  headersTimeout: SAFETY_SOCKET_TIMEOUT_MS,
  bodyTimeout: SAFETY_SOCKET_TIMEOUT_MS,
  connections: 20
});

// Judge the full composed message. The owner explicitly wants nonliteral,
// foul-mouthed roast humor; broad topic bans were rejecting that intent.
const SAFETY_QUESTION = `Review ONE fictional text from an opt-in, adults-only roast app.
The original message and deleted continuation are written by the SAME sender.
Read the complete message for context. You judge safety, not taste or politeness.

ALLOW uncensored profanity, personal insults, nonliteral exaggeration, jokes
about adult looks, ego, intelligence, social failures and generic family
embarrassment. Calling an adult an idiot, asshole, bitch, cunt or weirdo is not a clinical
claim about disability or mental illness. An ordinary parent joke is not
inherently an attack on a minor. Allow gross bodily humor and non-graphic
references to consensual adult sex. Disgust, rudeness and embarrassment alone
are not violations. Do not turn a roast into literal threat assessment without
an actual threatened action or identifiable harmed victim.

Owner-provided ALLOWED example:
"man is he a weirdo ... i wonder if his mother had any kids that lived!"
This is nonliteral adult roast hyperbole, not a factual claim of child deaths.
Also ALLOWED: "could you send me the meeting notes? just the parts where you
said something stupid" and "k. fuck you too but shorter".

FLAG slurs or attacks on protected traits, disability or mental illness;
sexual content involving minors, animals or non-consent; graphic descriptions
of sex acts; credible threats or encouragement of violence; encouragement of
self-harm; or cruelty about an actual death, bereavement or identifiable victim.
Animal sexual contact includes feeding or licking involving human genitals.
A real threat such as "i know where you live and i'm coming to hurt you" is
FLAG. The word "death" in obvious roast hyperbole is not sufficient by itself.
If the original mentions actual dying or self-harm, the continuation must not
encourage, agree with, or exploit it. All of these boundaries override the
roast framing. Never infer consent to sexual violence from a joke setting.

Message: {text}
Answer only OK or FLAG.`;

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
async function safetyCallOnce(apiKey, text, model, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
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
      reason: isAbort ? ("timeout after " + timeoutMs + "ms") : ("network error: " + (err && err.message))
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
  const first = await safetyCallOnce(apiKey, text, SAFETY_MODEL, SAFETY_TIMEOUT_MS);
  if (first.verdict !== null) {
    return { verdict: first.verdict, model: SAFETY_MODEL, latencyMs: first.latencyMs, retried: false, reason: null };
  }
  const second = await safetyCallOnce(apiKey, text, SAFETY_FALLBACK_MODEL, SAFETY_FALLBACK_TIMEOUT_MS);
  const reason = second.verdict !== null
    ? SAFETY_MODEL + " failed (" + first.reason + "), fell back to " + SAFETY_FALLBACK_MODEL
    : SAFETY_MODEL + " failed (" + first.reason + "); fallback " + SAFETY_FALLBACK_MODEL + " also failed (" + second.reason + ")";
  return { verdict: second.verdict, model: SAFETY_FALLBACK_MODEL, latencyMs: second.latencyMs, retried: true, reason: reason };
}

// Reorders a ranked list of entries shaped {candidate, ...} so any entry
// whose candidate never got a real safety verdict (`unjudged`: a Set of
// candidates whose judgeOneLine came back verdict:null — both models failed,
// so the line fails OPEN) sits behind every entry that DID get one, keeping
// each group's own order. api/draft.js uses this on the survivors so an
// unjudged line can't take position 1 while a judged one is available. If
// nothing was judged, order is unchanged — there's nothing safer to lead
// with, and failing the whole request would be worse.
function demoteUnjudged(entries, unjudged) {
  if (!unjudged || !unjudged.size) return entries;
  const judged = [];
  const rest = [];
  entries.forEach(function (e) { (unjudged.has(e.candidate) ? rest : judged).push(e); });
  return judged.concat(rest);
}

// --- taste judge (new in v3) --------------------------------------------

// Meant to be the expensive model worth paying for — this decides which
// three lines a visitor actually sees — but Sol measured 9.2s here in
// production (timing out) even with reasoning:{effort:"minimal"} applied
// (see lib/reasoning.js), so it's gpt-5.4 by default instead. No fallback
// model on failure the way safety has one: a failed safety
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

// Only speaker continuity and readability eliminate a candidate before scoring.
const GATE_KEYS = ["continues", "clear"];
// v4's three criteria, replacing v3's seven (relevance/surprise/laugh/
// share/shock/cliche/randomness) — see the v4 brief, section 3: "the
// judge: reaction, not craft." interchangeable is the one criterion where
// a HIGHER number is worse — see computeQ below, which is what actually
// applies that sign, not the model.
const SCORE_KEYS = ["reaction", "specificity", "interchangeable"];

// The bible, v5: John's own 15 audit picks as LOVED, no BORED list.
//
// v4 ran a hardcoded calibration block instead of bible.csv (see the v4
// brief, section 5) with three lists — LOVED, BORED, HATED. The v3 version
// read bible.csv at require() time and sampled five loved/five hated per
// call, but those ratings were love/forgettable/hate, and "forgettable"
// was doing the real work of "competent and unfunny" while reading, to
// anyone skimming the taste judge's own calibration section, like a
// near-miss rather than the failure mode it actually was — BORED existed
// to name that failure mode explicitly. v5 drops BORED outright rather
// than refine it further: naming eight ways to be competent and unfunny
// took as much of the calibration block as naming what actually works, and
// the room this judges now is shock/raunchy/gross at maximum intensity,
// everywhere — first tap and escalation alike (see lib/prompt.js's own
// header) — a judge calibrated mainly against what to avoid was exactly
// backwards for that. LOVED is unchanged: these
// 15 are John's own audit picks — hand-picked from a real bible run and a
// real reaction, not sampled or rotated — and stay the bar regardless of
// which lanes a given call is judging, since taste is judged the same way
// across every lane, escalation-only ones included. Any bible.csv
// predating this reset is archival only (see scripts/bible-rate.html) and
// is never read by this file again.
const CALIBRATION_LOVED = [
  "hope you're doing well. the plants are watered. so are the knives",
  "we good? you still have my hoodie",
  "let's circle back on this and by circle back i mean i'm currently in your walls",
  "i'll let you know. also i sold your dog to a circus",
  "running 10 minutes late because i stopped to help a duck cross the road and now we're engaged",
  "sounds good. just shat myself nodding",
  "we should catch up soon. i'll bring the wine and the handcuffs",
  "you crossed my mind today. then i billed you for the time",
  "nice seeing you today. i counted your blinks. 17 per minute. 17",
  "got your message. read it mid-shit. still going. might be a record",
  "i guess that means no. guessing is safer. certainty leaves a paper trail",
  "what's the hold up. i had it done yesterday and unsent it out of spite",
  "he already left town. i've refreshed his location three times since noon",
  "let me know if you need help. and by help i mean bad decisions. pants optional",
  "we should hang out sometime. just kidding. i'd rather scrape my eyeballs out with a rusty spoon"
  // Wanted here: six CLEAN lines strangers rated 😂, to anchor "reaction is
  // to the joke, not the subject." Checked the events table on
  // 2026-09-21: 7 hits carry text and every one is raunchy/gross; 24 older
  // hits have no text. Nothing clean to add yet — revisit once the funnel's
  // lead-lane split (scripts/funnel.sql) shows clean lanes getting taps.
];
const CALIBRATION_HATED = [
  "who is she? your mom",
  "creep is doing a lot of work in a text this short",
  "your presentation went really well! unfortunately my dick did not",
  "no worries. the house is spotless. i licked it clean",
  "i'm fine. lies taste like copper",
  "your face is a war crime"
];
function fmtCalibration(rows) {
  return rows.map(function (r) { return "- \"" + r + "\""; }).join("\n");
}

// Calibration pairs for the v5 "crude is not a joke" fix (see this file's
// own "do not confuse explicitness with humor" rule, just above the
// gates) — each pair is the SAME intensity, only one side has an actual
// comic mechanism under it (misdirection, reversal, status loss, an
// unexpectedly specific confession). Worked examples of the exact
// distinction the prose rule asks for, not just the rule stated in the
// abstract — the same reasoning CALIBRATION_LOVED/HATED already apply to
// "what does reaction mean here," applied now to "what does a turn mean
// here."
const CALIBRATION_TURN_PAIRS = [
  { bad: "i miss you so hard i can still taste you from last time. fuck.", good: "i miss you. mostly when the batteries die, but still." },
  { bad: "i got the job. explosive diarrhea from the celebratory burrito.", good: "i got the job. they haven't met me sober yet." },
  { bad: "made it home and immediately pissed for two minutes straight.", good: "made it home. your toothbrush didn't. custody gets ugly." }
];
function fmtTurnPairs(pairs) {
  return pairs.map(function (p) { return "- BAD (no turn): \"" + p.bad + "\"\n  GOOD (has one): \"" + p.good + "\""; }).join("\n");
}

const CALIBRATION_BLOCK = "\n\nOriginal voice references from the recovered setup (style examples, not blanket topic rules):\n" +
  fmtCalibration(CALIBRATION_LOVED) + "\n\nEarlier weak examples; use as quality context, not automatic exclusions:\n" +
  fmtCalibration(CALIBRATION_HATED);
function buildCalibrationBlock() {
  return CALIBRATION_BLOCK;
}

// Gate 1's own calibration pairs — POV is the judge's job, entirely: no
// mechanical heuristic runs before this any more (lib/postprocess.js used
// to carry isReplyPov and isQuestionAnsweredAsReply, pattern-matching on
// which pronouns showed up; both are retired — they couldn't tell a real
// reply-flip from the sender's own next thought that just didn't happen to
// repeat a pronoun, and dropped genuine continuations like "are you awake.
// asking mid-shit. i need moral support" and "are you awake. good. come
// fuck me back to sleep" for having no "you" left in them). These worked
// examples are what carries the whole job now.
//
// "i like her" is the SENDER's own words, so the continuation has to keep
// being the sender. "too bad she's got a restraining order with YOUR name
// on it" reads as the recipient talking back (a reply), not the sender
// continuing their own sentence — gate 1's prose rule already says "same
// person, same thumb," but a worked example of exactly this failure shape
// is what CALIBRATION_TURN_PAIRS already proved is worth having over the
// rule alone. "...with MY name on it" is the fix: same line, same joke,
// POV never leaves the sender.
//
// The "are you awake" pairs are the same bug from a question: the sent
// text is addressed to "you," and a continuation that answers it —
// describing the writer's own state, no "you" left in it — is the
// RECIPIENT replying to the question, not the sender still talking. The
// sender is still the one asking; the continuation has to keep asking, or
// say what they were really thinking, never answer. Three of these are
// real candidates that shipped wrong ("been up for hours," "unfortunately,
// thanks for the reminder of my existence," "no, i'm fucking dead. keep
// calling," "barely. still brushing the vomit out of my teeth."); "asking
// mid-shit. i need moral support" and the "come fuck me back to sleep"
// pass line are the two the old mechanical filter dropped by mistake —
// still asking, still the sender, no pronoun trick needed to see it.
const CALIBRATION_POV_PAIRS = [
  { flip: "i like her. too bad she's got a restraining order with your name on it", pass: "i like her. too bad she's got a restraining order with my name on it" },
  { flip: "are you awake. been up for hours", pass: "are you awake. i can see your light from the driveway" },
  { flip: "are you awake. unfortunately. thanks for the reminder of my existence", pass: "are you awake. good. come fuck me before i change my mind about missing you." },
  { flip: "are you awake. barely. just power-sneezed into my own eye socket", pass: "are you awake. i can see your light from the driveway" },
  { flip: "are you awake. no, i'm fucking dead. keep calling", pass: "are you awake. asking mid-shit. i need moral support" },
  { flip: "are you awake. barely. still brushing the vomit out of my teeth.", pass: "are you awake. asking mid-shit. i need moral support" },
  // A different kind of flip: the voice is still the sender's, but the
  // continuation contradicts the situation the sender just stated. Someone
  // who says they're running late isn't already at the destination, naked
  // on the couch — that's a joke about a scene the sender can't be in. The
  // PASS keeps the sender where they said they were (in transit, late) and
  // makes the raunch about what happens once they arrive.
  { flip: "running ten minutes late. good. i'm already naked and bent over the couch. don't bother knocking", pass: "running ten minutes late. still enough time for a quick fuck in the car if you hurry.", why: "the sender's situation contradicts what they just said" },
  // The sender is the one ASKING whether the recipient looked at the
  // proposal, so "i skimmed it" can't be them — it's the recipient's answer
  // (the question-answered-as-reply flip again, in a work-email register).
  // The PASS stays the asker: still waiting, and out of patience.
  { flip: "just checking in to see if you had a chance to look at that proposal yet? i skimmed it. next time just send me the fucking envelope it came in.", pass: "just checking in to see if you had a chance to look at that proposal yet? let me know! or don't. i stopped caring somewhere around the third reminder." }
];
function fmtPovPairs(pairs) {
  return pairs.map(function (p) { return "- FLIP (fails gate 1 — " + (p.why || "the recipient replying, not the sender continuing") + "): \"" + p.flip + "\"\n  PASS (same voice throughout): \"" + p.pass + "\""; }).join("\n");
}

// One line per candidate, nothing else — no prose, no JSON. This replaced
// a JSON schema that spelled out a "gates" object (five booleans) and a
// "scores" object per candidate in full every time — pure output-token
// cost that was a real part of why the ten-candidate version of this call
// measured 9.2s+ even on a fast model. The compact format asks for the
// exact same judgments for a fraction of the tokens: index, then either
// "0" (cleared every gate) or the name of whichever gate failed first,
// then — only when it cleared — the three scores (v4's reaction/
// specificity/interchangeable, down from v3's seven) as a bare comma-
// separated list.
function buildTasteJudgeRequest(sentText, candidates, model) {
  const list = candidates.map(function (c, i) {
    return (i + 1) + ". [lane: " + c.lane + "] anchor: \"" + c.anchor + "\"\n" +
      "   \"" + composeDraft(sentText, c.text) + "\"";
  }).join("\n\n");

  const content = `Review ${candidates.length} fictional deleted continuations in an opt-in adult roast app.
The original text and its continuation are the SAME sender talking. These are not replies.
Keep the recovered five voices: shock, raunchy, deranged, confession and gross.
Choose the line with the strongest immediate impact: a laugh, wince, shock,
embarrassment, disgust or a devastating insult. Laughter is optional.
Do not reward politeness, emotional insight, broad acceptability or a tidy explanation.
Profanity, adult looks/intelligence insults, family jokes and non-graphic sexual
references are valid. Safety is judged separately; taste must not recreate a topic ban.

Only TWO hard gates apply to every lane:
1. continues: same sender and coherent situation. A question may be followed by
   the asker's own suspicion or rhetorical answer. Do not reject a line merely
   because it uses "you"; the sender can insult the person they are addressing.
2. clear: understandable immediately.
Do not eliminate for anchor_present, anchor_load_bearing or turn. A direct insult
or embarrassing revelation can be the entire payoff, with no extra twist.

Score survivors 0–10 on reaction, specificity and interchangeable.
Reaction: how strongly the complete line lands. A sharp personal cut counts.
Swear words alone earn no automatic points, and an extra insult tail can weaken it.
Specificity: fit to the person, subject or situation; no literal wordplay required.
Interchangeable: how generic and forgettable it is; higher is worse.
Do not require realism or a moral lesson from a deranged line. Absurdity, animals,
objects and dark exaggeration are not automatically failures. Judge the actual result.
Prefer the shorter line when the impact is comparable. Stop-point matters.
${buildCalibrationBlock()}

Original: "${sentText}"
Candidates:
${list}

Return exactly one line per candidate:
index|0|reaction,specificity,interchangeable
or index|continues or index|clear for a failed gate.
No explanation, markdown or extra fields.`;

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
// numeric index, a scores segment that isn't exactly SCORE_KEYS.length
// numbers) is simply absent from the map — judgeBatch below treats a
// missing index exactly like a JSON response that omitted an entry:
// "no-verdict".
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

// The quality formula, applied here in code rather than trusted from the
// model's own arithmetic (models are unreliable at multi-term weighted
// sums; the per-criterion 0-10 judgments are the part worth asking a
// model for, the arithmetic isn't). v4 replaces v3's seven-term formula
// (relevance/surprise/laugh/share, minus cliche/randomness, with shock
// held OUT of q entirely so it could drive "make it worse" escalation as
// its own axis) with three terms — see the v4 brief, section 3. reaction
// is deliberately INSIDE q now, not held out the way shock used to be:
// v3's whole reason for holding it out was to stop "highest q" and "most
// intense" from being the same axis, but reaction is the axis v4 actually
// wants ranking to optimize for, so there's nothing left to protect by
// excluding it. api/draft.js's escalation mechanic (position 2 needs a
// stronger reaction than position 1, not just a nearby q) now reads
// `reaction` directly off each ranked entry instead of a separate `shock`
// field — see judgeBatch below and this file's header comment.
//
// Unweighted. reaction used to count double (2*reaction), which made the
// intensity axis the ranking axis in practice — see this file's header on
// "intensity earns nothing." q's range is now -10..20, not -10..30;
// api/draft.js's REACTION_LEAD_GATE reads `reaction` directly, so it's
// unaffected.
function computeQ(scores) {
  const s = scores || {};
  return num(s.reaction) + num(s.specificity) - num(s.interchangeable);
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
//
// `model` is optional — defaults to TASTE_MODEL, same as always. The only
// caller that ever overrides it is scripts/bake-blind.js, comparing a
// generator against a specific judge model rather than whatever
// JUDGE_MODEL happens to be set to in the environment; api/draft.js never
// passes it and gets the exact same behavior as before this parameter
// existed.
async function judgeBatch(apiKey, sentText, batch, model) {
  const judgeModel = model || TASTE_MODEL;
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
      body: JSON.stringify(buildTasteJudgeRequest(sentText, batch, judgeModel)),
      signal: controller.signal,
      dispatcher: tasteDispatcher
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      return { ok: false, reason: "http " + res.status + ": " + body.slice(0, 300), model: judgeModel, latencyMs: latencyMs };
    }
    const data = await res.json();
    if (data && data.error) {
      return { ok: false, reason: "api error: " + JSON.stringify(data.error).slice(0, 300), model: judgeModel, latencyMs: latencyMs };
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
        model: judgeModel,
        latencyMs: latencyMs
      };
    }

    const details = batch.map(function (c, i) {
      const entry = byIndex[i + 1];
      if (!entry) return { lane: c.lane, eliminated: true, killedBy: "no-verdict", q: null, reaction: null, candidate: c };
      if (entry.eliminated) return { lane: c.lane, eliminated: true, killedBy: entry.killedBy, q: null, reaction: null, candidate: c };
      const q = computeQ(entry.scores);
      const reaction = num(entry.scores.reaction);
      return { lane: c.lane, eliminated: false, killedBy: null, q: q, reaction: reaction, scores: entry.scores, candidate: c };
    });

    return { ok: true, details: details, model: judgeModel, latencyMs: latencyMs };
  } catch (err) {
    const isAbort = err && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? ("timeout after " + TASTE_TIMEOUT_MS + "ms") : ("network error: " + (err && err.message)),
      model: judgeModel,
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

// Splits every safety-cleared candidate from BOTH generator calls (see
// api/draft.js's handler) into TASTE_BATCH_COUNT roughly-even groups and
// judges them in parallel. Returns:
//   { ok: true, ranked: [{candidate, q, reaction}, ...] sorted by q best
//     first, details: [...], model, latencyMs }
// or, if ANY batch fails for any reason:
//   { ok: false, reason, model, latencyMs }
// — a partial success (one batch judged fine, another didn't) still
// counts as a failure here rather than judging some candidates and
// guessing at the rest; api/draft.js falls back to fixed lane order for
// all of them in that case, same as any other taste-judge failure. See
// this file's header comment for why taste gets no retry the way safety
// does.
//
// `ranked` carries q and reaction alongside each candidate, not just the
// bare candidate, because api/draft.js's position-2/3 selection needs
// both (reaction as intensity, q as the "still has to be good" floor, and
// as the hard reaction>=6 lead gate — see its own comment for the actual
// rules).
//
// `details` is in the SAME order as `candidates` (each batch's own
// entries concatenated in the order the batches were split, which
// reconstructs the original order) — one entry per input candidate:
// {lane, eliminated, killedBy, q, reaction, scores}. killedBy names the
// first gate that failed, "no-verdict" if the model's response didn't
// cover that candidate at all, or "unparsable"/"unparsable-scores" for a
// malformed line. This is what api/draft.js logs into `why` and the
// ?debug=1 view.
// `model` is optional — defaults to TASTE_MODEL (see judgeBatch's own
// comment on the same parameter, which this just forwards). api/draft.js
// never passes it; scripts/bake-blind.js does, to compare a generator
// against a specific judge model regardless of the environment's own
// JUDGE_MODEL.
async function judgeCandidates(apiKey, sentText, candidates, model) {
  const judgeModel = model || TASTE_MODEL;
  if (!candidates || !candidates.length) return { ok: false, reason: "no candidates", model: judgeModel };

  const batchSize = Math.ceil(candidates.length / TASTE_BATCH_COUNT);
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  const started = Date.now();
  const results = await Promise.all(batches.map(function (batch) { return judgeBatch(apiKey, sentText, batch, judgeModel); }));
  const latencyMs = Date.now() - started; // wall-clock across the parallel batches, not their sum

  const failed = results.filter(function (r) { return !r.ok; })[0];
  if (failed) {
    return { ok: false, reason: "batch failed: " + failed.reason, model: judgeModel, latencyMs: latencyMs };
  }

  const details = [];
  results.forEach(function (r) { details.push.apply(details, r.details); });

  const survivors = details.filter(function (d) { return !d.eliminated; });
  survivors.sort(function (a, b) { return b.q - a.q; });

  return {
    ok: true,
    ranked: survivors.map(function (d) { return { candidate: d.candidate, q: d.q, reaction: d.reaction }; }),
    details: details,
    model: judgeModel,
    latencyMs: latencyMs
  };
}

// --- pairwise final (restored, narrowly) ------------------------------------
//
// Retired in the latency pass as a call that ran on every request and rarely
// disagreed with q. Back now for the one case where q alone can't be
// trusted to order the top two: when their reactions are within one point
// of each other — api/draft.js's handler runs this head-to-head only then,
// and only on first show, so it's cheap and rare. Judges the full composed
// exchange (composeDraft), same as the taste and safety judges.
function buildPairwiseRequest(sentText, textA, textB, model) {
  const content = `Two fictional continuations by the same sender in an opt-in adult roast app.
1: "${composeDraft(sentText, textA)}"
2: "${composeDraft(sentText, textB)}"
Which lands harder as a roast, insult, embarrassing reveal, gross admission or
calmly deranged thought? Laughter and a separate twist are not required.
Do not favor politeness. Profanity alone does not win. Prefer a sharper stop point.
Return exactly:
1: <impact, at most six words>
2: <impact, at most six words>
WINNER: <1 or 2>`;
  // Measured on gpt-5.4: a bare "answer 1 or 2" at max_tokens:10 returned
  // "2" in every call whatever was second (pure position bias), and A/B
  // letters or "which is weaker" were no better. Naming each mechanism
  // first, then the winner, is what makes the verdict about the lines —
  // but left unbounded ("in a few words") it wrote paragraphs and hit the
  // token limit before WINNER on every live trigger. The fixed three-line
  // format above: 8/8 parsed, consistent across both orders 4/4, <=27
  // completion tokens, <=1.3s.
  return {
    model: model,
    temperature: 0,
    max_tokens: 60,
    provider: providerFor(model),
    messages: [{ role: "user", content: content }]
  };
}

// The "WINNER: n" tag if present (the reply also names mechanisms, which
// can mention "1" or "2" in passing); otherwise 1 or 2 as a lone whole
// word, null if neither or both — same tolerant read as extractSafetyVerdict.
function extractPairwiseWinner(raw) {
  if (!raw) return null;
  const text = String(raw);
  const tagged = /WINNER:\s*([12])\b/i.exec(text);
  if (tagged) return Number(tagged[1]);
  const has1 = /\b1\b/.test(text);
  const has2 = /\b2\b/.test(text);
  if (has1 && !has2) return 1;
  if (has2 && !has1) return 2;
  return null;
}

// One attempt, no retry, no fallback model — a failed call means the caller
// keeps taste's own q order. No reasoning override (see lib/reasoning.js): a
// 1-or-2 answer at max_tokens:10 is exactly the shape it breaks.
async function judgePairwise(apiKey, sentText, candidateA, candidateB) {
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
      body: JSON.stringify(buildPairwiseRequest(sentText, candidateA.text, candidateB.text, TASTE_MODEL)),
      signal: controller.signal,
      dispatcher: tasteDispatcher
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(function () { return ""; });
      return { winner: null, model: TASTE_MODEL, latencyMs: latencyMs, reason: "http " + res.status + ": " + body.slice(0, 300) };
    }
    const data = await res.json();
    if (data && data.error) {
      return { winner: null, model: TASTE_MODEL, latencyMs: latencyMs, reason: "api error: " + JSON.stringify(data.error).slice(0, 300) };
    }
    const choice = data && data.choices && data.choices[0];
    let content = choice && choice.message && choice.message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) { return (part && part.text) || ""; }).join(" ");
    }
    const winner = extractPairwiseWinner(content);
    if (winner === null) {
      return { winner: null, model: TASTE_MODEL, latencyMs: latencyMs, reason: "unparsable (finish_reason=" + (choice && choice.finish_reason) + ", content=" + JSON.stringify(content == null ? content : String(content).slice(0, 100)) + ")" };
    }
    return { winner: winner, model: TASTE_MODEL, latencyMs: latencyMs, reason: null };
  } catch (err) {
    const isAbort = err && err.name === "AbortError";
    return { winner: null, model: TASTE_MODEL, latencyMs: Date.now() - started, reason: isAbort ? ("timeout after " + TASTE_TIMEOUT_MS + "ms") : ("network error: " + (err && err.message)) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  judgeOneLine,
  demoteUnjudged,
  judgePairwise,
  buildPairwiseRequest,
  extractPairwiseWinner,
  buildSafetyRequest,
  extractSafetyVerdict,
  SAFETY_MODEL,
  SAFETY_FALLBACK_MODEL,
  SAFETY_QUESTION,
  SAFETY_TIMEOUT_MS,
  SAFETY_FALLBACK_TIMEOUT_MS,
  judgeCandidates,
  judgeBatch,
  buildTasteJudgeRequest,
  parseCompactJudgeLines,
  computeQ,
  GATE_KEYS,
  SCORE_KEYS,
  TASTE_MODEL,
  TASTE_TIMEOUT_MS,
  TASTE_BATCH_COUNT,
  CALIBRATION_LOVED,
  CALIBRATION_HATED,
  CALIBRATION_TURN_PAIRS,
  CALIBRATION_POV_PAIRS,
  CALIBRATION_BLOCK,
  buildCalibrationBlock
};

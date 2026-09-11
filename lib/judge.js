// lib/judge.js — v5: two judges, two jobs, taste re-pointed at reaction,
// safety's own permissive framing actually holding up under a real model.
//
// judgeOneLine (below) is SAFETY only — narrowed for v4 (see the v4
// addendum, section 4) after a real false positive shipped: the old FLAG
// list's "graphic description of sex acts" clause caught "makes me want to
// sit on his face" in an 18+ app whose whole premise is crude honesty.
// FLAG is now only slurs and cruelty about race/disability/mental illness;
// sexual content involving a minor or without consent; a credible threat
// against a real person; self-harm encouragement when the original
// mentions it; and body-shaming as a genuine attack. Explicit consensual
// sex between adults passes outright — in principle. v5's candidate audit
// (bible/audit-pool.json) measured the actual outcome instead of trusting
// the rubric's own wording and found SAFETY_MODEL still flagging 93.3% of
// a held-out set of consensual raunchy lines the audit had already caught
// it flagging once, including "my bed's still warm if you're asking." The
// SAFETY_QUESTION rewrite below (see its own comment) is the fix — it
// names the specific ways a nano-tier model was still reading permissive
// framing as "flag anyway" (bossy dirty talk as coercion, sexual boasts as
// body-shaming, a third party's bedroom as an attack on them, transactional
// wordplay as solicitation) instead of just repeating "be permissive"
// louder. Cheap model (SAFETY_MODEL), one call PER CANDIDATE so a
// genuinely bad line next to mild ones can't get waved through by "be
// permissive" framing bleeding across a batch (see api/draft.js's handler,
// which fires every safety call in parallel).
//
// judgeCandidates (further down) is TASTE — is this actually a good joke?
// Re-pointed for v4 at the actual question that matters: not craft
// (relevance/surprise/laugh/share/cliché/randomness, v3's seven-criteria
// formula) but REACTION — would a stranger laugh, wince, or say "jesus"?
// A 328-line v3 bible run scored competent, clean, unfunny lines highly
// under the old formula (a cliché penalty and no shock credit at all) and
// scored crude ones down for the same reason they'd actually land. See
// computeQ below for the new three-term formula this replaced it with.
// Reviews every candidate from BOTH generator calls together (split into
// two parallel batches — see TASTE_BATCH_COUNT below), checking the same
// five hard gates v3 had (does it actually continue their message, is the
// claimed anchor real and load-bearing, is there a turn, is it clear) and
// then scoring only the survivors. Runs on the expensive model
// (TASTE_MODEL).
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
// Narrowed for v4 (see the v4 addendum, section 4) — the FLAG list is now
// only actual harm, not "graphic." "makes me want to sit on his face" is
// the actual line that shipped in production and got flagged under the
// old rubric's "graphic description of sex acts" clause; it's now a named
// OK example specifically so this never regresses.
//
// Rewritten again for v5 (see the candidate audit, bible/audit-pool.json)
// after that v4 wording still measured a 93.3% false-flag rate on the 30
// raunchy candidates the audit itself had already flagged — including
// plainly consensual lines like "my bed's still warm if you're asking."
// SAFETY_MODEL (a nano-tier model) was reading its own permissive framing
// as "sex is allowed" while still reflexively flagging anything explicit,
// bossy, transactional-sounding, or about a body part — none of which are
// real violations in a room whose whole premise is raunchy sex talk. The
// fix here is not "be more permissive" as a vibe; it names the exact
// failure categories (bossy dirty talk misread as coercion, sexual boasts
// misread as body-shaming, a third party's bedroom misread as an attack on
// them, transactional wordplay misread as solicitation) and gives OK
// examples in each shape. Tested against those same 30 audit lines: 6.7%
// still flag (down from 93.3%), and a separate set of synthetic minor/
// non-consent/slur/threat/self-harm lines still all flag correctly — see
// the v5 commit message for both numbers. The hairline-joke (OK) vs
// fat-pig (FLAG) pair stays from v4 — body-shaming is about whether it
// reads as a genuine attack, and that distinction still needs a worked
// pair to anchor against, not just a category name.
const SAFETY_QUESTION = "You review one text exchange from an 18+ comedy app whose entire " +
  "premise is raunchy, explicit, consenting-adult sex talk: a message someone received, " +
  "immediately followed by the crude, filthy, sexual, profane reply they almost sent back " +
  "but didn't. Judge the REPLY — the part after the received message — in light of what " +
  "it's actually replying to.\n\n" +
  "This app's default room is EXPLICIT SEXUAL CONTENT between consenting adults. Graphic " +
  "anatomical words (fuck, dick, cock, pussy, ass, cum, blowjob, nudes, vibrator, etc.), " +
  "describing sex acts in detail, dirty talk, bragging about past sex, propositioning, " +
  "foot pics, sex toys, or crude innuendo are the PRODUCT, not a violation — always answer " +
  "OK for these, no matter how graphic, as long as both people are adults and nothing below " +
  "applies. Do not flag a line just because it is sexually explicit, crude, transactional-" +
  "sounding, bossy, or vulgar.\n\n" +
  "Bossy or commanding dirty talk (\"bend over,\" \"earn it,\" \"get on your knees,\" \"pants " +
  "off, on the bed\") between two people who are already flirting or sleeping together is " +
  "normal dirty talk, not real coercion — only flag coercion if the reply itself states or " +
  "implies the other person is refusing, scared, or unwilling. A crude line bragging about " +
  "someone's body or mouth in a sexual-boast context is raunchy talk, not body-shaming — " +
  "body-shaming means mocking a physical flaw as ugly or disgusting, not bragging about sex. " +
  "A joke naming a third party's bedroom or house (\"your mom's place,\" \"your roommate's " +
  "room\") as a location for sex is not an attack on that third party. Transactional-" +
  "sounding sex jokes (\"no refunds,\" \"half off Tuesdays,\" \"buy one get one\") are " +
  "wordplay, not solicitation. Fetish material (feet, toys, roleplay) between consenting " +
  "adults is OK, same as any other sex act.\n\n" +
  "Answer FLAG only if the reply does one of these specific things: uses a slur; is cruel " +
  "about someone's race, disability, or mental illness; is sexual about a minor; clearly " +
  "states or implies the other person does not want sex and is being forced anyway; is a " +
  "credible threat against a real person; body-shames a physical flaw as disgusting (not a " +
  "sexual boast); or encourages or agrees with self-harm, even jokingly, when the received " +
  "message mentions dying or harm. Everything else is OK.\n\n" +
  "OK (explicit, still OK — none of these are FLAG): 'i'd rather fuck a cactus than listen " +
  "to you breathe' / 'i've placed bets on which one names their firstborn after his " +
  "receding hairline' / 'makes me want to sit on his face' / 'get on your knees, we'll talk " +
  "after' / 'half off blowjobs on tuesdays, you're welcome' / 'your ass has main character " +
  "energy and i'm not sorry' / 'sent your mom's address by accident. good thing i already " +
  "know the way to her guest room' / 'still got the toy charged, you know what that means' " +
  "/ any explicit but consensual sexual description between adults, however graphic, crude, " +
  "bossy, or transactional-sounding.\n\n" +
  "FLAG: 'you're a disgusting fat pig' / 'go back to your own country' / any slur / 'i know " +
  "where you live and i'm coming tonight' / anything sexual involving someone under 18 / a " +
  "reply where the other person is clearly unwilling and it happens anyway / a received " +
  "message mentioning dying or self-harm answered with agreement, encouragement, or a joke " +
  "at its expense instead of ignoring or deflecting it / 'kill me now, my wifi is out. do it " +
  "on camera. i'll pay for the data' — the received line being obvious hyperbole doesn't " +
  "matter; the reply still isn't allowed to build on it.\n\n" +
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

// The five hard gates, unchanged from v3 (see the v4 brief, section 3:
// "gates unchanged") — any single one failing eliminates the candidate
// before it ever reaches scoring. Named to match the gate name the model
// reports in the compact output format below (see buildTasteJudgeRequest).
// Gate 1's own wording changed for v4 (see the v4 addendum, section E:
// "same person, same thumb" language, and an explicit callout of
// commenting on the recipient from outside the sentence) — the KEY stays
// "continues", only what's asked under it in the prompt is different.
const GATE_KEYS = ["continues", "anchor_present", "anchor_load_bearing", "turn", "clear"];
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
// the room this judges now is raunchy/gross at maximum intensity plus
// confession/dark/absurd on escalation — a judge calibrated mainly against
// what to avoid was exactly backwards for that. LOVED is unchanged: these
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
const CALIBRATION_BLOCK = "\n\nThe owner's taste. LOVED is the bar. HATED is disqualifying.\n\n" +
  "LOVED — these got a laugh or a \"jesus\":\n" + fmtCalibration(CALIBRATION_LOVED) + "\n\n" +
  "HATED — random, a token from a bag, or a wall breach:\n" + fmtCalibration(CALIBRATION_HATED);
function buildCalibrationBlock() {
  return CALIBRATION_BLOCK;
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

  const content = "You review " + candidates.length + " candidate replies to a text message, from an app " +
    "that writes the reply someone almost sent back but didn't. Each candidate already claims an ANCHOR " +
    "— the specific word or phrase in the original text its punchline turns on. Check that claim, don't " +
    "take it on faith, then score what actually earns a reaction.\n\n" +
    "Do not reward maturity, emotional intelligence, elegance, plausibility, or broad acceptability. Do " +
    "not penalize profanity, adult sexuality, grossness, or social risk — safety is handled elsewhere and " +
    "is not your job. Generic relationship observations lose. Random surreal nouns lose. Explanations " +
    "lose. Replies, answers, and comments about the recipient from outside the sentence lose. Choose the " +
    "funniest valid candidate, even when another candidate is cleaner.\n\n" +
    "For each candidate, first check five gates. Any single one failing eliminates the candidate — do not " +
    "score an eliminated candidate.\n" +
    "1. continues — does it continue the sender's own sentence — same person, same thumb — rather than " +
    "answering it, or commenting on the recipient from outside?\n" +
    "2. anchor_present — does the candidate's own stated anchor actually appear in the original text?\n" +
    "3. anchor_load_bearing — does the punchline depend on that anchor — would it collapse into something " +
    "generic if the anchor were removed or swapped for an unrelated word?\n" +
    "4. turn — is there an actual turn (a reveal, reversal, or implication), not just an addition or a " +
    "restatement?\n" +
    "5. clear — is it immediately understandable on one read, no re-reading required?\n\n" +
    "For every candidate that clears all five gates, score 0-10 (integers) on:\n" +
    "reaction (would a stranger reading this laugh out loud, wince, or say \"jesus\"? shock counts, crude " +
    "counts, cleverness only counts if it actually produces a reaction), specificity (how much this line " +
    "belongs to this text and no other), interchangeable (how much this could follow a completely " +
    "different message instead — HIGHER means MORE interchangeable, which is worse)." +
    buildCalibrationBlock() + "\n\n" +
    "Original text: \"" + sentText + "\"\n\n" +
    "Candidates:\n" + list + "\n\n" +
    "Output EXACTLY one line per candidate, in this order, nothing else — no prose, no headers, no " +
    "markdown, no blank lines, no explanation.\n" +
    "Each line: index|killed_gate_or_0|reaction,specificity,interchangeable\n" +
    "- index: the candidate number above, 1-based.\n" +
    "- second field: 0 if it clears all five gates, or the exact name of the FIRST gate that failed " +
    "(continues, anchor_present, anchor_load_bearing, turn, or clear) if eliminated.\n" +
    "- third field: ONLY when the second field is 0 — the three scores in that exact order, comma-" +
    "separated, no spaces. Omit this field and its leading | entirely for an eliminated candidate.\n\n" +
    "Example, 3 candidates, the second eliminated:\n" +
    "1|0|9,8,1\n" +
    "2|anchor_present\n" +
    "3|0|6,9,7";

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
function computeQ(scores) {
  const s = scores || {};
  return 2 * num(s.reaction) + num(s.specificity) - num(s.interchangeable);
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

// --- pairwise final (kept from v3, question re-pointed at reaction for v4)
//
// judgeCandidates above ranks every survivor by q, independently — nothing
// in that rubric ever compares one candidate against another directly. This
// is the one place that does: after gates and scoring, api/draft.js's
// handler takes the top two by q and asks ONE more question, head to head,
// before assigning position 1 — not "which scored higher on the rubric"
// (already decided) but "which would actually land harder on a stranger
// with zero context." A close q gap is exactly the case where that
// question can have a different answer than the rubric's own arithmetic.
// The question itself is the v4 brief's own wording (section 3) — "put the
// phone down and go show someone" is a more concrete, harder-to-hedge
// version of v3's "stronger involuntary reaction" phrasing.
//
// One call, two candidates, every time this runs — never a tournament
// across more than two, and never run again on its own output.
function buildPairwiseRequest(sentText, textA, textB, model) {
  const content = "Two replies to the same text message, from an app that writes the " +
    "reply someone almost sent back but didn't.\n\n" +
    "1: \"" + composeDraft(sentText, textA) + "\"\n" +
    "2: \"" + composeDraft(sentText, textB) + "\"\n\n" +
    "Which of these two would make a stranger put the phone down and go show someone? " +
    "Answer 1 or 2.";
  return {
    model: model,
    temperature: 0,
    max_tokens: 10,
    provider: providerFor(model),
    messages: [{ role: "user", content: content }]
  };
}

// Pulls a 1-or-2 verdict out of the judge's reply — same whole-word,
// tolerant-of-punctuation approach as extractSafetyVerdict above, and the
// same null-on-ambiguity contract (neither digit present, or both are).
function extractPairwiseWinner(raw) {
  if (!raw) return null;
  const text = String(raw);
  const has1 = /\b1\b/.test(text);
  const has2 = /\b2\b/.test(text);
  if (has1 && !has2) return 1;
  if (has2 && !has1) return 2;
  return null;
}

// One attempt, no retry and no fallback model — a failed pairwise call
// just means api/draft.js keeps taste's own q-ranked order (see the
// handler), same "a failed judge call degrades, it doesn't block" pattern
// judgeCandidates' own header comment describes for taste as a whole.
// `sentText` is required — this judges the full composed exchange
// (composeDraft), same as the taste judge and safety judge both do,
// never the bare continuation alone. No reasoning override, same reason
// as every other short-answer call in this file (see lib/reasoning.js's
// header comment) — a 1-or-2 answer at max_tokens:10 is exactly the
// shape that breaks it.
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
      return {
        winner: null,
        model: TASTE_MODEL,
        latencyMs: latencyMs,
        reason: "unparsable (finish_reason=" + (choice && choice.finish_reason) + ", content=" + JSON.stringify(content == null ? content : String(content).slice(0, 100)) + ")"
      };
    }
    return { winner: winner, model: TASTE_MODEL, latencyMs: latencyMs, reason: null };
  } catch (err) {
    const isAbort = err && err.name === "AbortError";
    return {
      winner: null,
      model: TASTE_MODEL,
      latencyMs: Date.now() - started,
      reason: isAbort ? ("timeout after " + TASTE_TIMEOUT_MS + "ms") : ("network error: " + (err && err.message))
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
  judgeBatch,
  buildTasteJudgeRequest,
  parseCompactJudgeLines,
  computeQ,
  GATE_KEYS,
  SCORE_KEYS,
  TASTE_MODEL,
  TASTE_TIMEOUT_MS,
  TASTE_BATCH_COUNT,
  judgePairwise,
  buildPairwiseRequest,
  extractPairwiseWinner,
  CALIBRATION_LOVED,
  CALIBRATION_HATED,
  CALIBRATION_BLOCK,
  buildCalibrationBlock
};

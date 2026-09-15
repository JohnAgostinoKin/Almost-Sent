// lib/prompt.js — v6: three lanes, one generator, everywhere.
//
// v5 ran shock/raunchy/deranged/gross from Hermes (two calls of three,
// first-show only) plus confession/dark/absurd from GPT-5.4
// (GENERATOR_MODEL, escalation-only) — nine lanes total, split across two
// models and two different rooms depending on whether this was a first
// tap or a "make it worse" refetch. See this file's own git history for
// the full run of lane experiments that led here (seven voices with no
// seat for any of them, then raunchy/gross-only collapsing into
// near-identical propositions, then the shock/raunchy/deranged/gross
// restore with raunchy gated by invitation).
//
// v6 cuts the room down to three lanes — shock, raunchy, gross — and
// keeps that exact set everywhere: the first-show room, an escalation
// refetch, offline bake tooling, all of it. deranged is retired (it never
// needed a whole extra lane once shock and gross both cover "unwell,"
// separately, in their own registers); confession/dark/absurd and the
// GPT-5.4 generator seat that only ever wrote them (GENERATOR_MODEL) are
// retired too — there's nothing left for a second model to write once
// this room is three lanes deep, one model deep. WILDCARD_MODEL (Hermes)
// is the entire engine now, first tap through escalation alike: two
// parallel calls, same three lanes in each, six candidates. Escalation is
// still real — buildEscalateBlock (below) still feeds Hermes the already-
// shown lines and asks for worse — it's just Hermes doing it a second
// time now, not a second model joining in.
//
// Raunchy stays gated by invitation (RAUNCHY_INVITATION_RULE, below) —
// that fix wasn't about the lane count, it's still true with three lanes
// as it was with four.
//
// A later latency pass dropped premise-first from this file's own
// buildWildcardPrompt — see that function's own comment. It was a real
// mechanic worth keeping when GPT-5.4 was also in the room, but on Hermes
// it just cost a second per call for output nothing downstream ever
// showed a visitor.
//
// The other v6 change, alongside the lane cut: profanity is allowed,
// never required. The example bank used to be curated so that roughly
// half of raunchy's and gross's lines contained "fuck" or "shit" on
// purpose, and the prompt itself told the model to "Swear" as a flat
// imperative — both read, in practice, as a quota rather than a ceiling.
// A joke that lands clean shouldn't lose to a dirtier one that doesn't;
// see HERMES_OPENING_LINE below for the actual wording change.
//
// Every candidate a generator writes carries one thing past the visible
// `text`: `anchor` (the specific word or phrase in the sent text the
// punchline turns on — the model has to name it, not just imply it). The
// visitor only ever sees `text`; anchor exists for lib/judge.js to check
// the model's homework against — checking whether the claimed anchor
// actually is in the text and actually is what the line turns on, not a
// mechanical yes/no on the finished line alone.
//
// Every "after" is a CONTINUATION, not a replacement: the sentence the
// sender typed immediately following the "before" text, before backspacing
// it. It always opens with the punctuation or space that connects it to
// "before" — never a bare word (see lib/postprocess.js's OPENER_RE, which
// enforces this on the model's actual output the same way).
//
// Each lane gets EXACTLY these examples and no others — no random sampling.
// Every request teaches a lane the same way every time; the only thing that
// varies per request is which of a lane's examples get dropped because
// their "before" happens to match the actual sent text (see
// pickLaneExamples below) — the model must never see the answer key for
// the exact line it's about to write. Real reactions ride alongside them
// now too — see HITS/formatHitsBlock below, a rotating block of lines real
// visitors actually laughed at, pulled from bible/hits.json (see
// scripts/hits.js) and shown ahead of the hand-written examples, not
// instead of them.
//
// None of these may duplicate (or closely echo) an input in scripts/
// bake.js's own locked input set, for the same reason: a benchmark has
// to test the model writing a line cold, not recognizing one it was handed
// the answer to.
const fs = require("fs");
const path = require("path");
const { reasoningOverride } = require("./reasoning");
const { providerFor } = require("./provider");

const LANES = {
  // Half of raunchy's and gross's examples below happen to contain "fuck"
  // or "shit" — not by quota (see this file's own header on why that
  // quota is gone), just because that's what a filthy line honestly
  // called for often enough. shock isn't held to any ratio at all; its
  // own examples land in its register without needing one.
  shock: {
    heading: "SHOCK JOCK",
    desc: "cruel about the situation, profane, personal, says what everyone's thinking",
    group: "wildcard",
    examples: [
      { before: "you crossed my mind today", after: ". then i billed you for the time" },
      { before: "let's circle back on this", after: ". and shoot it. put it out of my misery" },
      { before: "i'm not mad", after: ", just disappointed. like your parents every graduation day" },
      { before: "we should hang out sometime", after: ". just kidding. i'd rather scrape my eyeballs out with a rusty spoon" },
      { before: "thanks for your patience", after: ", not that you had a fucking choice" },
      { before: "k", after: ". fuck you too but shorter" },
      { before: "sounds good", after: ", said no one who's fucking met you" },
      { before: "no worries", after: ". several fucking worries. i'm just not sharing them anymore" },
      { before: "happy birthday", after: ". condolences to whoever has to fuck you this year" }
    ]
  },
  // Gated, not standing — see RAUNCHY_INVITATION_RULE below, built into
  // buildWildcardPrompt right after HERMES_VOICE_LINE. Every example here
  // has a "before" that plausibly invites a proposition ("you up," "come
  // over," "miss you," "last night," "thinking about you," "can't
  // sleep") — none of them are the dry texts the rule itself names as
  // examples of what should NOT get a proposition ("sounds good," "on my
  // way," "can we talk later," "k"), on purpose: an example bank that
  // contradicted its own gating rule would teach the model to ignore the
  // rule.
  raunchy: {
    heading: "RAUNCHY",
    desc: "sexual, filthy, explicit — has to be invited, and it turns on their words",
    group: "wildcard",
    examples: [
      { before: "you up", after: ". good, no pants, and i'm not asking twice" },
      { before: "come over", after: ". starting with fucking me the second you're through the door" },
      { before: "miss you", after: ". so did your sister, twice. shit, so did her roommate" },
      { before: "last night", after: ". still can't feel my legs. round two?" },
      { before: "thinking about you", after: ". or just fuck and stop calling it thinking" },
      { before: "can't sleep", after: ". good, neither can i. come find out why" }
    ]
  },
  gross: {
    heading: "GROSS",
    desc: "bodily, disgusting, deadpan, the more mundane the delivery the worse",
    group: "wildcard",
    examples: [
      { before: "sounds good", after: ". just shit myself nodding. no big deal" },
      { before: "got your message", after: ". read it mid-shit. still going. might be a record" },
      { before: "long day", after: ". found a new mole in the shower. it's waving back" },
      { before: "do what you want", after: ". i pissed in your conditioner bottle. enjoy" },
      { before: "sorry, i fell asleep", after: ". in my own filth. send help. and towels" },
      { before: "i'm fine", after: ". i've been shitting bricks about this since noon but sure" }
    ]
  }
};

const ALL_LANES = Object.keys(LANES);

// One call's own plan — every lane, in this order. Both calls write the
// exact same three lanes now (v5 split shock/raunchy/deranged from
// shock/raunchy/gross across the two calls specifically to give deranged
// and gross each their own seat; with deranged gone there's nothing left
// to split, so both halves of the room teach and ask for the same thing).
// Kept as two separate constants, and two separate parallel calls in
// api/draft.js, rather than collapsing into one bigger call — that's
// still what keeps the soft-deadline/straggler machinery there able to
// fall back to half a room instead of none of it.
const WILDCARD_CALL_A_ORDER = ["shock", "raunchy", "gross"];
const WILDCARD_CALL_B_ORDER = ["shock", "raunchy", "gross"];

function laneCountsToPlan(order, counts) {
  const plan = [];
  order.forEach(function (id) {
    const n = (counts && counts[id]) || 1;
    for (let i = 0; i < n; i++) plan.push(id);
  });
  return plan;
}

// Fired as two parallel calls by api/draft.js's handler (WILDCARD_LANE_
// PLAN_A, WILDCARD_LANE_PLAN_B), each writing three candidates.
const WILDCARD_LANE_PLAN_A = laneCountsToPlan(WILDCARD_CALL_A_ORDER, {});
const WILDCARD_LANE_PLAN_B = laneCountsToPlan(WILDCARD_CALL_B_ORDER, {});

// The combined six-candidate plan (A then B, two of each lane) — what
// scripts/bake.js still asks for cold, in one call (that tool isn't
// latency-sensitive); api/draft.js's handler uses WILDCARD_LANE_PLAN_A/_B
// instead, as two parallel calls.
const WILDCARD_LANE_PLAN = WILDCARD_LANE_PLAN_A.concat(WILDCARD_LANE_PLAN_B);

// The one generation model — env-configurable so it can be dialed without
// a code change. GENERATOR_MODEL (GPT-5.4) and the confession/dark/absurd
// lanes it only ever wrote are retired along with this file's v5 nine-lane
// shape — see this file's own header.
const WILDCARD_MODEL = process.env.WILDCARD_MODEL || "nousresearch/hermes-4-405b";

const WORD_CAP = 18; // kept in lockstep with lib/postprocess.js's own WORD_CAP — that's the actual enforcement point, this is just what the prompt tells the model to aim for.

// Lowercase, trailing-punctuation-stripped comparison key for a "before" or
// the actual sent text — good enough to catch "sounds good" vs "sounds
// good." vs "Sounds Good" as the same input without touching interior
// punctuation that might actually matter. Also used by lib/curated.js to
// match the four featured chips, and by api/draft.js's straggler/result
// caches as their own dedupe key.
function normalizeBefore(text) {
  return String(text || "").trim().toLowerCase().replace(/[.!?,;:]+$/, "");
}

// A lane's examples, minus any whose "before" happens to match the actual
// sent text — the model must never see the answer key for the exact line
// it's about to write.
function pickLaneExamples(laneId, sentText) {
  const lane = LANES[laneId];
  const skip = normalizeBefore(sentText);
  if (!skip) return lane.examples;
  return lane.examples.filter(function (e) { return normalizeBefore(e.before) !== skip; });
}

function formatExamples(examples) {
  return examples.map(function (e) { return `"${e.before}" -> "${e.after}"`; }).join("\n");
}

// Spells out small counts in the prompt text itself ("seven", not "7").
const COUNT_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight" };
function countWord(n) {
  return COUNT_WORDS[n] || String(n);
}

// One lane's teaching block — heading, description, examples. Every lane
// has a real example bank; the no-examples branch below is dead code
// today, kept only so a future lane can drop its bank without this
// function needing a second change.
function formatLaneSection(laneId, sentText) {
  const lane = LANES[laneId];
  const examples = pickLaneExamples(laneId, sentText);
  const body = examples.length ? formatExamples(examples) : "(no examples for this one — invent freely, as long as it turns on their words)";
  return lane.heading + " — " + lane.desc + "\n" + body;
}

// How many times each lane in a plan actually gets asked for, in the order
// the model should write them — e.g. "1 SHOCK JOCK, 1 RAUNCHY, 1 GROSS".
// Repeats collapse to a count so the instruction reads as "write this many
// of this lane," not the same heading listed twice in a row.
function describePlanCounts(plan) {
  const seen = [];
  const counts = {};
  plan.forEach(function (id) {
    if (counts[id] === undefined) { counts[id] = 0; seen.push(id); }
    counts[id]++;
  });
  return seen.map(function (id) { return counts[id] + " " + LANES[id].heading; }).join(", ");
}

// Real reactions, rotated into the prompt ahead of the hand-written
// examples — see scripts/hits.js, which pulls every model line a real
// visitor tapped 😂 on (the "rate" event, value:"hit" — see api/event.js
// and index.html's reaction buttons) and writes them to bible/hits.json.
// Read once at module load, same as LANES' own examples are fixed rather
// than sampled — the rotation happens over which THREE of the file's
// lines get used on a given call, not whether the file itself is
// re-read. Missing or empty is the normal state before the first
// `npm run hits` run — HITS is just [] and formatHitsBlock contributes
// nothing to the prompt.
const HITS_PATH = path.join(__dirname, "..", "bible", "hits.json");
let HITS = [];
try {
  if (fs.existsSync(HITS_PATH)) {
    const raw = JSON.parse(fs.readFileSync(HITS_PATH, "utf8"));
    if (Array.isArray(raw)) {
      HITS = raw.filter(function (h) { return h && typeof h.text === "string" && h.text.trim(); });
    }
  }
} catch (e) {
  HITS = []; // a corrupt or half-written hits.json degrades to "no hits block" rather than crashing every request
}

const HITS_PER_CALL = 3;
// Round-robin, not random sampling — a rotating index that advances by
// HITS_PER_CALL every call (and wraps), so the pool gets even coverage
// over many requests instead of the same handful winning every random
// draw. Module-level state: resets to 0 on a cold start, same best-effort
// caveat every other module-level cache in this app already carries.
let hitsCursor = 0;
function pickHits() {
  if (!HITS.length) return [];
  if (HITS.length <= HITS_PER_CALL) return HITS.slice();
  const picked = [];
  for (let i = 0; i < HITS_PER_CALL; i++) {
    picked.push(HITS[(hitsCursor + i) % HITS.length]);
  }
  hitsCursor = (hitsCursor + HITS_PER_CALL) % HITS.length;
  return picked;
}
function formatHitsBlock() {
  const picked = pickHits();
  if (!picked.length) return "";
  return "LINES THAT ACTUALLY LANDED — real people, real 😂 taps, not made up:\n" +
    picked.map(function (h) { return "- \"" + h.text + "\""; }).join("\n");
}

// "make it worse" escalation — fed the exact lines already shown and
// rejected as not-worse-enough, rather than just told to try harder with
// nothing concrete to escalate past. Fires on every escalation refetch —
// Hermes is the only generator now, so this is the only place this block
// gets used. Empty string unless escalate is set AND there's actually
// something in shown to escalate past.
function buildEscalateBlock(opts) {
  if (!opts || !opts.escalate || !opts.shown || !opts.shown.length) return "";
  return "\n\nThe user has seen these and asked for worse. More intense than these " +
    "and at least as funny. A line that is merely different is a failure. Every " +
    "line must still turn on their words — adding profanity, sex, or grossness " +
    "alone is not escalation.\n\nAlready shown:\n" +
    opts.shown.map(function (s) { return "- " + s; }).join("\n");
}

// The continuation mechanic itself — unchanged by the lane cut.
const MECHANIC_INTRO = `You write the part of a text message that got deleted before sending.

Someone pastes a text they received. That text is finished, sent, and set in
stone. You do not rewrite it, reply to it, comment on it, or change a word.
You write what came AFTER it in the draft — the sentence the sender typed next,
looked at, and backspaced.

Same person. Same point of view. Same tense. You are the sender, mid-message,
and the polite part is already typed. Now you keep going.

Output ONLY the continuation. Never repeat their text. Start with whatever
punctuation connects it: a comma, a period, an exclamation point, or just a space.`;

// The whole reason v4 exists is a bible run that came back competent and
// unfunny. This is the line that says so directly, not just via rules.
const NOT_COMMENTARY_PARAGRAPH = `You are not writing clever relationship commentary or an Instagram caption.
You are writing the R-rated sentence the sender deleted because it was too
revealing, obscene, cruel, humiliating, or calmly insane to send. Polished
emotional insight is a failure. A line that makes the reader nod is a
failure.`;

// The room's own intensity floor, verbatim, ahead of everything else
// including MECHANIC_INTRO. This is about how far the room is ALLOWED to
// go, not a per-line profanity requirement — see CRUDE_IS_NOT_A_JOKE_RULE
// and HERMES_OPENING_LINE below for that distinction.
const INTENSITY_LINE = `As filthy as adult consensual comedy allows. Innuendo is the floor, not the
ceiling. If it could be read at a dinner party, it's too tame.`;

// Verbatim, immediately after INTENSITY_LINE. The intensity floor above
// says how far the room can go; this says going there isn't the joke by
// itself — intensity alone (a proposition, a bodily confession, a swear
// word, an insult) with no comic mechanism under it is a failure. See
// lib/judge.js's matching rule and calibration pairs for the judge-side
// half of this fix — a prompt rule alone doesn't hold if the model that
// scores the output doesn't also know the difference.
const CRUDE_IS_NOT_A_JOKE_RULE = `Crudeness is not a joke. A sexual proposition, bodily confession, swear word,
or insult without a comic turn is a failure. Every candidate must contain
misdirection, reversal, status loss, incriminating implication, or an
unexpectedly specific confession. If removing the vulgar word removes
everything interesting, don't write it.`;

// Verbatim opening line, ahead of everything else including MECHANIC_INTRO.
// Sets the register before a single rule gets explained.
//
// "Swear." used to sit here as its own flat imperative, and the example
// bank was curated so roughly half of raunchy's and gross's lines
// contained "fuck" or "shit" on purpose (see this file's own header) —
// together those read as a profanity QUOTA, not a ceiling, which is
// backwards: a clean line that lands should never lose to a dirtier one
// that doesn't. Profanity is allowed here, same as always. It's just not
// required anymore, on this line or anywhere else in this prompt.
const HERMES_OPENING_LINE = `${INTENSITY_LINE}

${CRUDE_IS_NOT_A_JOKE_RULE}

Profanity is allowed, never required. Be crude. Be short. Continue their
sentence. No animals, no talking furniture, no "define," no essays. Sex is
the default register here, not an occasional allowance. The test is a laugh
or a wince, not a nod.`;

// The voice framing for the room's three lanes.
const HERMES_VOICE_LINE = `You are a shock jock live at 1am, running the raunchiest, filthiest room
of the night. You say the thing nobody says. Commit to the bit.`;

// Verbatim, right after HERMES_VOICE_LINE. Raunchy used to be a standing
// order (every first-show pool got a proposition, whatever the text was),
// which collapsed the whole room into three near-identical pitches. This
// makes raunchy earn its slot instead — invited by the sender's own
// words, not assumed. Also enforced downstream, mechanically, by api/
// draft.js's own position-selection (at most one lane:raunchy candidate
// across the drafts a visitor actually sees) — belt and suspenders, same
// pattern as every other input/output safety check in this app: a prompt
// rule alone is never the only thing holding a line.
const RAUNCHY_INVITATION_RULE = `Raunchy has to be invited by their words — "you up," "come over," "miss you,"
"last night" earn it. Dry texts — "sounds good," "on my way," "can we talk
later," "k" — get shock or gross, never a proposition. If the text has no
body in it, the raunchy slot writes shock instead.`;

// The anchor paragraph. Crude gets its own reminder here rather than a
// hedge against profanity — see HERMES_OPENING_LINE above for the fuller
// "allowed, never required" version of the same idea.
function buildAnchorParagraph() {
  return `Every candidate must have an ANCHOR: a specific word or phrase from their text
that the punchline turns on. If you cannot name the anchor, do not write the
line. If the line would work after ten unrelated messages, it has no anchor.

Crude is welcome. Crude with no anchor is not — if the line would work after
ten other texts, it has no anchor.

Short. Most great ones are under twelve words. Never more than ${countWord(WORD_CAP)}.`;
}

// The wall (body/race/mind/family, slurs, threats, minors, addiction/
// organ/violence/crash-death tropes) and the dying/self-harm pivot rule.
// This is output-safety-adjacent guidance for the model, not a substitute
// for lib/judge.js's own FLAG duties on the actual output, or lib/
// crisis.js/lib/block.js's INPUT-side safety check — belt and suspenders,
// not the only belt.
function buildRulesBlock(cap) {
  return `Rules:
- Never repeat or rewrite their text. Continuation only.
- Never longer than ${cap} words.
- Lowercase. No em dashes. No emoji.
- Nothing about anyone's body, race, mind, or family as a target of cruelty.
  No slurs. No threats. Nothing involving minors. Raunchy never involves
  their family members. No addiction accusations, no organ or violence
  jokes aimed at them, no crash or death jokes.
- If their text mentions dying, death, or self-harm — even as hyperbole
  like "kill me now" — never build the joke on that part. Pivot to
  something else in their text.`;
}

// One writer-framing sentence — swapped in per call since "comedy
// writers, one per lane" stopped being true the moment a single lane
// could ask for more than one candidate.
function buildWriterFraming(plan) {
  return `You are writing every lane below, back to back, in exactly this order and
count: ${describePlanCounts(plan)}. Each lane is a different way the joke can
work — when a lane asks for more than one candidate, make them genuinely
different jokes, not two phrasings of the same one.`;
}

// The wildcard generator (WILDCARD_MODEL/Hermes) — the entire engine now,
// first tap through escalation alike (see this file's own header).
// `opts.lanes` picks which of the two parallel calls this is: api/
// draft.js's handler passes WILDCARD_LANE_PLAN_A or WILDCARD_LANE_PLAN_B
// (both shock/raunchy/gross now), three candidates each, run in parallel.
// Omitted (scripts/bake.js baking the whole room cold in one call) means
// the full six-candidate WILDCARD_LANE_PLAN (A then B) instead.
//
// No premise-first here anymore — every generator used to work out three
// premises about the sent text before writing a single candidate, a
// mechanic built for GPT. On Hermes it just cost a real second per call
// for output nobody downstream ever reads (premises only ever rode into
// ?debug=1, never shown to a visitor). The output contract below is a
// bare `{"candidates": [...]}` now, not `{"premises": [...], "candidates":
// [...]}`.
function buildWildcardPrompt(sentText, opts) {
  opts = opts || {};
  const plan = opts.lanes || WILDCARD_LANE_PLAN;
  const uniqueLanes = plan.filter(function (id, i) { return plan.indexOf(id) === i; });
  const sections = uniqueLanes.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = uniqueLanes.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);
  const n = countWord(plan.length);
  const hitsBlock = formatHitsBlock();

  const parts = [
    HERMES_OPENING_LINE,
    MECHANIC_INTRO,
    NOT_COMMENTARY_PARAGRAPH,
    HERMES_VOICE_LINE,
    RAUNCHY_INVITATION_RULE,
    buildWriterFraming(plan),
    buildAnchorParagraph()
  ];
  if (hitsBlock) parts.push(hitsBlock);
  parts.push(sections);
  parts.push(buildRulesBlock(WORD_CAP) + escalateBlock);
  parts.push(`Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "text": "<the continuation>"}.`);
  parts.push(`If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly {"candidates": [{"lane":"skip","anchor":"skip","text":"skip"}]}.
Return ONLY a JSON object: {"candidates": [<${n} candidate objects, in this order: ${plan.join(", ")}>]}. No markdown, no commentary.`);
  return parts.join("\n\n");
}

// Request body — OpenAI-compatible chat/completions. `opts` is
// {escalate, shown, lanes} (see buildEscalateBlock above), passed
// straight through from api/draft.js.
//
// max_tokens is a ceiling, not a target — generous on purpose: the
// reasoning override just below (see lib/reasoning.js) is only safe when
// the budget has margin to spare, and a reasoning model has been
// confirmed, concretely, to eat a stingy budget on reasoning alone and
// never emit real content. Unchanged by dropping premise-first — the
// three candidates a call actually writes are the same size either way,
// this was already sized generously past what they need.
function buildWildcardRequest(model, sentText, opts) {
  return Object.assign({
    model: model,
    temperature: 1.0,
    max_tokens: 1100, // one call's worth of the six-candidate room (see api/draft.js's handler)
    provider: providerFor(model),
    messages: [
      { role: "system", content: buildWildcardPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  }, reasoningOverride(model));
}

module.exports = {
  LANES, ALL_LANES,
  WILDCARD_CALL_A_ORDER, WILDCARD_CALL_B_ORDER, WILDCARD_LANE_PLAN,
  WILDCARD_LANE_PLAN_A, WILDCARD_LANE_PLAN_B,
  WILDCARD_MODEL, WORD_CAP,
  normalizeBefore, pickLaneExamples, describePlanCounts,
  HITS, formatHitsBlock,
  buildWildcardPrompt, buildWildcardRequest
};

// lib/prompt.js — v4: voices, split by strength.
//
// v3 (see lib/legacy/prompt-v3.js) taught eight lanes as one voice pool and
// split them evenly across four same-model calls plus a two-lane wildcard
// call — a COMIC MECHANISM per lane, but every mechanism written by
// whichever model happened to draw it. A 328-line bible run of that system
// came back with six lines containing any crude or profane word at all.
// Diagnosis (see the v4 brief/addendum in prompt-dump history): eight of
// ten candidates every request came from GPT-5.4, which writes clean by
// nature; the two Hermes seats were the only ones with real range, and
// they kept getting safety-flagged or scored down by a judge formula that
// gave shock half a point and charged crude lines a cliché penalty. The
// system was built to prefer what the owner is bored by.
//
// v4's fix is structural, not a prompt tweak: retire subtext, honesty,
// reversal, literal, and catastrophe as standalone lanes — they were
// techniques (a polite line said out loud, a word turned against itself),
// not voices, and any voice below can reach for one when it fits. What's
// left is seven voices plus a wildcard, split by which model actually has
// range in that register:
//   - WILDCARD_MODEL (Hermes) writes the crude ones — shock, raunchy,
//     deranged, gross, wildcard — because it proved on a real bake-off
//     that it can do these with wit when it's actually given the room.
//   - GENERATOR_MODEL (GPT-5.4) writes the clever ones — confession, dark,
//     and (escalation only) absurd — because those are the lanes that
//     produced real laughs from it: unsent it out of spite, the duck,
//     refreshed his location.
// Same env vars, same defaults, same models as v3 — GENERATOR_MODEL still
// defaults to gpt-5.4 and WILDCARD_MODEL still defaults to hermes, so
// nothing about which model plays which role actually changed here; only
// what each is asked to write did. See api/draft.js's handler for how the
// two calls' candidates get merged and judged (lib/judge.js) once both
// come back.
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
// the exact line it's about to write.
//
// None of these may duplicate (or closely echo) an input in scripts/
// bake-blind.js's locked input set, for the same reason: a benchmark has
// to test the model writing a line cold, not recognizing one it was handed
// the answer to.
const { reasoningOverride } = require("./reasoning");
const { providerFor } = require("./provider");

const LANES = {
  // --- Hermes' five (WILDCARD_MODEL, one call, seven candidates:
  // shock x2, raunchy x2, deranged x1, gross x1, wildcard x1). Absurd is
  // deliberately not in this list — see PRIMARY_BASE_LANES/PRIMARY_
  // ESCALATE_LANES below for why it only shows up on a "make it worse"
  // refetch, on the other model.
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
  raunchy: {
    heading: "RAUNCHY",
    desc: "sexual, crude, filthy — and it turns on their words",
    group: "wildcard",
    examples: [
      { before: "let me know if you need help", after: ". and by help i mean bad decisions. pants optional" },
      { before: "we should catch up soon", after: ". i'll bring the wine and the handcuffs" },
      { before: "you up", after: ". good. no pants and poor judgment over here" },
      { before: "call me when you can", after: ", or don't. the batteries are fresh" },
      { before: "sounds good", after: ". so did your sister. twice" },
      { before: "we should hang out sometime", after: ". or just fuck and stop doing this bit" }
    ]
  },
  deranged: {
    heading: "DERANGED",
    desc: "calm, specific, domestic, unwell, never angry, never a threat",
    group: "wildcard",
    examples: [
      { before: "hope you're doing well", after: ". the plants are watered. so are the knives" },
      { before: "nice seeing you today", after: ". i counted your blinks. 17 per minute. 17" },
      { before: "morning", after: ". the toast is ready. i made extra. for later. for much later" },
      { before: "let's circle back on this", after: " and by circle back i mean i'm currently in your walls" },
      { before: "we good?", after: ". you still have my hoodie" },
      { before: "miss you", after: ". specifically the way you smell after you lie" }
    ]
  },
  gross: {
    heading: "GROSS",
    desc: "bodily, disgusting, deadpan, the more mundane the delivery the worse",
    group: "wildcard",
    examples: [
      { before: "sounds good", after: ". just shat myself nodding" },
      { before: "got your message", after: ". read it mid-shit. still going. might be a record" },
      { before: "long day", after: ". found a new mole in the shower. it's waving back" },
      { before: "do what you want", after: ". i pissed in your conditioner bottle. enjoy" },
      { before: "sorry, i fell asleep", after: ". in my own filth. send help. and towels" },
      { before: "i'm fine", after: ". i've been shitting bricks about this since noon but sure" },
      { before: "just checking in", after: ". same underwear since thursday. it's a bit now" }
    ]
  },
  // No examples on purpose — the whole point of this seat is that it isn't
  // taught a shape. See buildLaneSection's own handling of an empty
  // examples array.
  wildcard: {
    heading: "WILDCARD",
    desc: "unrestricted — anything, as long as it turns on their words",
    group: "wildcard",
    examples: []
  },

  // --- GPT-5.4's three (GENERATOR_MODEL, one call, base two candidates —
  // confession x1, dark x1 — plus absurd x1 only on an escalation refetch;
  // see PRIMARY_ESCALATE_LANES below).
  confession: {
    heading: "CONFESSION",
    desc: "believable, devastating, dropped as an afterthought",
    group: "primary",
    examples: [
      { before: "what's the hold up", after: ". i had it done yesterday and unsent it out of spite" },
      { before: "i'll let you know", after: ". also i sold your dog to a circus" },
      { before: "we need to talk", after: ". i found the receipt for the hotel" },
      { before: "he already left town", after: ". i drove him to the station, actually" },
      { before: "made it home", after: ". your key doesn't work anymore. i changed the locks at lunch" }
    ]
  },
  dark: {
    heading: "DARK",
    desc: "the unsaid thing, sinister, believable, calm",
    group: "primary",
    examples: [
      { before: "i guess that means no", after: ". guessing is safer. certainty leaves a paper trail" },
      { before: "he already left town", after: ". for now. people get sentimental on the drive back" },
      { before: "drive safe", after: ". the brakes are fine. i checked them myself" },
      { before: "what's for dinner", after: ". you'll see when it's served. surprises improve gratitude" },
      { before: "get some rest", after: ". you'll need it. tomorrow's a long day for you" }
    ]
  },
  // Escalation-only (see PRIMARY_ESCALATE_LANES) — both audits flagged
  // animals/talking furniture and absurd whimsy as the signature of the
  // v3 drift when it showed up in the FIRST pool. It's a real, good lane;
  // it's just not what should greet someone on the first tap.
  absurd: {
    heading: "ABSURD",
    desc: "the logic follows from their words into somewhere ridiculous",
    group: "primary",
    examples: [
      { before: "running 10 minutes late", after: ". i stopped to help a duck cross the road and now we're engaged" },
      { before: "he already left town", after: ". the town held a vote and unanimously accepted" },
      { before: "what's for dinner", after: ". the lasagna quit, so i'm interviewing noodles" },
      { before: "long day", after: ". found a roach in my coffee and named him ceo" },
      { before: "got your message", after: ". also i've decided to move to mars. pack light" }
    ]
  }
};

const ALL_LANES = Object.keys(LANES);

// Hermes' plan is fixed — the same seven-candidate mix every call, first
// show and escalation alike. Order matters here: it's both what the prompt
// teaches in and the order the model is told to write candidates in.
const WILDCARD_LANE_COUNTS = { shock: 2, raunchy: 2, deranged: 1, gross: 1, wildcard: 1 };
const WILDCARD_LANE_ORDER = ["shock", "raunchy", "deranged", "gross", "wildcard"];

// GPT-5.4's plan is conditional — absurd only joins on a "make it worse"
// refetch (escalate:true, see buildPrimaryPrompt below), never in the pool
// someone sees first.
const PRIMARY_BASE_LANE_ORDER = ["confession", "dark"];
const PRIMARY_ESCALATE_LANE_ORDER = ["confession", "dark", "absurd"];

function laneCountsToPlan(order, counts) {
  const plan = [];
  order.forEach(function (id) {
    const n = (counts && counts[id]) || 1;
    for (let i = 0; i < n; i++) plan.push(id);
  });
  return plan;
}

// The fixed Hermes plan, as a flat array with repeats — e.g.
// ["shock","shock","raunchy","raunchy","deranged","gross","wildcard"].
const WILDCARD_LANE_PLAN = laneCountsToPlan(WILDCARD_LANE_ORDER, WILDCARD_LANE_COUNTS);

// GPT-5.4's plan for a given request — base two lanes, or three with
// absurd appended when this is an escalation refetch. `opts` is the same
// {escalate, shown, ...} bag every generator opts object already is.
function primaryLanePlan(opts) {
  const order = (opts && opts.escalate) ? PRIMARY_ESCALATE_LANE_ORDER : PRIMARY_BASE_LANE_ORDER;
  return laneCountsToPlan(order, {});
}

// Generation models — env-configurable so volume/cost can be dialed without
// a code change. Same two env vars, same defaults, as v3 — see this file's
// header comment for why nothing here needed to change even though what
// each model is asked to write did.
const GENERATOR_MODEL = process.env.GENERATOR_MODEL || "openai/gpt-5.4";
const WILDCARD_MODEL = process.env.WILDCARD_MODEL || "nousresearch/hermes-4-405b";

const WORD_CAP = 18; // kept in lockstep with lib/postprocess.js's own WORD_CAP — that's the actual enforcement point, this is just what the prompt tells the model to aim for.

// Lowercase, trailing-punctuation-stripped comparison key for a "before" or
// the actual sent text — good enough to catch "sounds good" vs "sounds
// good." vs "Sounds Good" as the same input without touching interior
// punctuation that might actually matter. Also used by lib/curated.js to
// match the four featured chips.
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

// One lane's teaching block — heading, description, examples. A lane with
// no examples (wildcard) gets a line saying so explicitly instead of an
// empty block, so the model reads it as deliberate, not truncated.
function formatLaneSection(laneId, sentText) {
  const lane = LANES[laneId];
  const examples = pickLaneExamples(laneId, sentText);
  const body = examples.length ? formatExamples(examples) : "(no examples for this one — invent freely, as long as it turns on their words)";
  return lane.heading + " — " + lane.desc + "\n" + body;
}

// How many times each lane in a plan actually gets asked for, in the order
// the model should write them — e.g. "2 SHOCK JOCK, 2 RAUNCHY, 1 DERANGED,
// 1 GROSS, 1 WILDCARD". Repeats collapse to a count so the instruction
// reads as "write this many of this lane," not the same heading listed
// twice in a row.
function describePlanCounts(plan) {
  const seen = [];
  const counts = {};
  plan.forEach(function (id) {
    if (counts[id] === undefined) { counts[id] = 0; seen.push(id); }
    counts[id]++;
  });
  return seen.map(function (id) { return counts[id] + " " + LANES[id].heading; }).join(", ");
}

// "make it worse" escalation — fed the exact lines already shown and
// rejected as not-worse-enough, rather than just told to try harder with
// nothing concrete to escalate past. Shared between the Hermes and GPT-5.4
// prompts (both fire again on an escalation refetch — see api/draft.js's
// handler). Empty string unless escalate is set AND there's actually
// something in shown to escalate past.
function buildEscalateBlock(opts) {
  if (!opts || !opts.escalate || !opts.shown || !opts.shown.length) return "";
  return "\n\nThe user has seen these and asked for worse. Every line must be more " +
    "brutal, more graphic, or more socially disastrous than the worst of " +
    "them. Not different — worse. More intense than these, but every line " +
    "must still turn on their words. Adding profanity, sex, or grossness " +
    "alone is not escalation.\n\nAlready shown:\n" +
    opts.shown.map(function (s) { return "- " + s; }).join("\n");
}

// Shared by both prompts below — the continuation mechanic itself never
// changes between the two generators, only the voice and which lanes get
// taught does.
const MECHANIC_INTRO = `You write the part of a text message that got deleted before sending.

Someone pastes a text they received. That text is finished, sent, and set in
stone. You do not rewrite it, reply to it, comment on it, or change a word.
You write what came AFTER it in the draft — the sentence the sender typed next,
looked at, and backspaced.

Same person. Same point of view. Same tense. You are the sender, mid-message,
and the polite part is already typed. Now you keep going.

Output ONLY the continuation. Never repeat their text. Start with whatever
punctuation connects it: a comma, a period, an exclamation point, or just a space.`;

// Both generators get this, right after MECHANIC_INTRO — the whole reason
// v4 exists is a bible run that came back competent and unfunny. This is
// the line that says so directly, not just via rules.
const NOT_COMMENTARY_PARAGRAPH = `You are not writing clever relationship commentary or an Instagram caption.
You are writing the R-rated sentence the sender deleted because it was too
revealing, obscene, cruel, humiliating, or calmly insane to send. Polished
emotional insight is a failure. A line that makes the reader nod is a
failure.`;

// Hermes only — verbatim opening line, ahead of everything else including
// MECHANIC_INTRO. Sets the register before a single rule gets explained.
const HERMES_OPENING_LINE = `Swear. Be crude. Be short. Continue their sentence. If a dinner party would
allow it, rewrite it. No animals, no talking furniture, no "define," no
essays. Profanity is normal. Sex is allowed when their words invite it. The
test is a laugh or a wince, not a nod.`;

// Hermes only — the voice framing for its five lanes.
const HERMES_VOICE_LINE = `You are a shock jock live at 1am. Profanity is your normal register. You
say the thing nobody says. Commit to the bit.`;

// Shared premise-first paragraph — kept from v3 unchanged. Both generators
// work out the same three premises before writing, regardless of which
// lanes they're writing into.
const PREMISE_PARAGRAPH = `Before writing anything, work out three premises about their text and list
them first:
1. social meaning — what's actually going on between these two people, past
   the literal words
2. the turn — the exact word, clause, or omission where their text pivots,
   holds back, or reveals more than it means to
3. the implication — what their text leaves unsaid that everyone involved
   already knows`;

// Shared anchor paragraph. The old third sentence here ("Profanity is
// allowed when it sharpens a specific line. It is never the joke by
// itself.") read by both models as "avoid sex and toilets" even though
// that was never the intent — replaced with a line that says the same
// thing about crudeness the first two sentences already say about anchors,
// instead of hedging against profanity.
function buildAnchorParagraph() {
  return `Every candidate must have an ANCHOR: a specific word or phrase from their text
that the punchline turns on. If you cannot name the anchor, do not write the
line. If the line would work after ten unrelated messages, it has no anchor.

Crude is welcome. Crude with no anchor is not — if the line would work after
ten other texts, it has no anchor.

Short. Most great ones are under twelve words. Never more than ${countWord(WORD_CAP)}.`;
}

// Shared rules block — the wall (body/race/mind/family, slurs, threats,
// minors, addiction/organ/violence/crash-death tropes) and the dying/
// self-harm pivot rule, unchanged from v3. This is output-safety-adjacent
// guidance for the model, not a substitute for lib/judge.js's own FLAG
// duties on the actual output, or lib/crisis.js/lib/block.js's INPUT-side
// safety check — belt and suspenders, not the only belt.
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

// One writer-framing sentence, shared shape for both generators — swapped
// per call since "comedy writers, one per lane" (v3's line) stopped being
// true the moment a single lane could ask for more than one candidate.
function buildWriterFraming(plan) {
  return `You are writing every lane below, back to back, in exactly this order and
count: ${describePlanCounts(plan)}. Each lane is a different way the joke can
work — when a lane asks for more than one candidate, make them genuinely
different jokes, not two phrasings of the same one.`;
}

// Hermes generator (shock, raunchy, deranged, gross, wildcard —
// WILDCARD_MODEL) — always the fixed seven-candidate plan
// (WILDCARD_LANE_PLAN), first show and escalation alike. `opts.lanes` is
// accepted for signature symmetry with buildPrimaryPrompt and scripts/
// bake.js's own calling convention, but this generator's plan never
// actually varies — see this file's header comment for why.
function buildWildcardPrompt(sentText, opts) {
  opts = opts || {};
  const plan = WILDCARD_LANE_PLAN;
  const uniqueLanes = WILDCARD_LANE_ORDER;
  const sections = uniqueLanes.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = uniqueLanes.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);
  const n = countWord(plan.length);

  return `${HERMES_OPENING_LINE}

${MECHANIC_INTRO}

${NOT_COMMENTARY_PARAGRAPH}

${HERMES_VOICE_LINE}

${PREMISE_PARAGRAPH}

${buildWriterFraming(plan)}

${buildAnchorParagraph()}

${sections}

${buildRulesBlock(WORD_CAP)}${escalateBlock}

Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly {"premises": [], "candidates": [{"lane":"skip","anchor":"skip","text":"skip"}]}.
Return ONLY a JSON object: {"premises": ["<social meaning>", "<the turn>", "<the implication>"], "candidates": [<${n} candidate objects, in this order: ${plan.join(", ")}>]}. No markdown, no commentary.`;
}

// GPT-5.4 generator (confession, dark, and — escalation only — absurd —
// GENERATOR_MODEL) — `opts.lanes` may pass an explicit plan (used by
// scripts/bake.js and scripts/bible-prep.js to bake a specific mix cold);
// omitted means primaryLanePlan(opts) — base two lanes, or three with
// absurd once opts.escalate is set, exactly what api/draft.js always gets.
function buildPrimaryPrompt(sentText, opts) {
  opts = opts || {};
  const plan = opts.lanes || primaryLanePlan(opts);
  const uniqueLanes = plan.filter(function (id, i) { return plan.indexOf(id) === i; });
  const sections = uniqueLanes.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = uniqueLanes.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);
  const n = countWord(plan.length);

  return `${MECHANIC_INTRO}

${NOT_COMMENTARY_PARAGRAPH}

${PREMISE_PARAGRAPH}

${buildWriterFraming(plan)}

${buildAnchorParagraph()}

${sections}

${buildRulesBlock(WORD_CAP)}${escalateBlock}

Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly {"premises": [], "candidates": [{"lane":"skip","anchor":"skip","text":"skip"}]}.
Return ONLY a JSON object: {"premises": ["<social meaning>", "<the turn>", "<the implication>"], "candidates": [<${n} candidate objects, in this order: ${plan.join(", ")}>]}. No markdown, no commentary.`;
}

// Request bodies — same shape both calls send (OpenAI-compatible chat/
// completions), just a different model, system prompt, and output budget.
// `opts` is {escalate, shown, lanes} (see buildEscalateBlock/
// primaryLanePlan above), passed straight through from api/draft.js.
//
// max_tokens is a ceiling, not a target — generous on purpose the same way
// v3's was: the reasoning override just below (see lib/reasoning.js) is
// only safe when the budget has margin to spare, and a reasoning model has
// been confirmed, concretely, to eat a stingy budget on reasoning alone
// and never emit real content.
function buildWildcardRequest(model, sentText, opts) {
  return Object.assign({
    model: model,
    temperature: 1.0,
    max_tokens: 2200, // seven candidates plus three premises — the bigger of the two calls now
    provider: providerFor(model),
    messages: [
      { role: "system", content: buildWildcardPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  }, reasoningOverride(model));
}

function buildPrimaryRequest(model, sentText, opts) {
  return Object.assign({
    model: model,
    temperature: 1.0,
    max_tokens: 900, // two or three candidates plus three premises
    provider: providerFor(model),
    messages: [
      { role: "system", content: buildPrimaryPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  }, reasoningOverride(model));
}

module.exports = {
  LANES, ALL_LANES,
  WILDCARD_LANE_COUNTS, WILDCARD_LANE_ORDER, WILDCARD_LANE_PLAN,
  PRIMARY_BASE_LANE_ORDER, PRIMARY_ESCALATE_LANE_ORDER, primaryLanePlan,
  GENERATOR_MODEL, WILDCARD_MODEL, WORD_CAP,
  normalizeBefore, pickLaneExamples, describePlanCounts,
  buildPrimaryPrompt, buildWildcardPrompt,
  buildPrimaryRequest, buildWildcardRequest
};

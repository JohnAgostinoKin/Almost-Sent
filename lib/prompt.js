// lib/prompt.js — v3: lanes, not shapes.
//
// The old model (see lib/legacy/prompt-v2.js) taught four shapes that were
// really four flavors of one register — brevity, profanity, reversal — and
// let one safety judge double as the taste judge. A lane is a different
// COMIC MECHANISM, not a different flavor of crude: subtext works by saying
// the polite line's real meaning out loud, word reversal works by turning
// their own word against them, dark implication works by never stating the
// threat it implies. Different lanes fail differently and succeed
// differently, which is the point — see api/draft.js's handler for how the
// resulting candidates get judged (lib/judge.js) now that taste and safety
// are two separate jobs.
//
// Every candidate a generator writes carries one thing past the visible
// `text`: `anchor` (the specific word or phrase in the sent text the
// punchline turns on — the model has to name it, not just imply it). The
// visitor only ever sees `text`; anchor exists for lib/judge.js to check
// the model's homework against — checking whether the claimed anchor
// actually is in the text and actually is what the line turns on, not a
// mechanical yes/no on the finished line alone.
//
// A `mechanism` field (a few words on how the anchor becomes the joke)
// used to ride along too — cut once the taste judge moved to a compact,
// scores-only output format (see lib/judge.js) that only ever needed the
// anchor to check, never the mechanism explanation. One less field the
// generator has to spend output tokens writing.
// Every "after" is a CONTINUATION, not a replacement: the sentence the
// sender typed immediately following the "before" text, before backspacing
// it. It always opens with the punctuation or space that connects it to
// "before" — never a bare word (see lib/postprocess.js's OPENER_RE, which
// enforces this on the model's actual output the same way).
//
// Each lane gets EXACTLY these examples and no others — no random sampling
// the way lib/legacy/prompt-v2.js's EXAMPLES_PER_SHAPE draw used to work.
// Every request teaches a lane the same way every time; the only thing that
// varies per request is which of a lane's examples get dropped because
// their "before" happens to match the actual sent text (see
// pickLaneExamples below) — the model must never see the answer key for
// the exact line it's about to write.
//
// None of these may duplicate (or closely echo) an input in scripts/
// bake-blind.js's locked input set — same rule lib/legacy/prompt-v2.js's
// EXAMPLES pool followed against scripts/bake.js's harness, for the same
// reason: a benchmark has to test the model writing a line cold, not
// recognizing one it was handed the answer to.
const { reasoningOverride } = require("./reasoning");
const { providerFor } = require("./provider");

const LANES = {
  subtext: {
    heading: "SUBTEXT",
    desc: "what the polite line actually means, said out loud",
    group: "primary",
    examples: [
      { before: "per my last email", after: ". and the four before it. reading remains optional for you" },
      { before: "no rush", after: ". i've already told everyone you're the reason it's late" },
      { before: "let's touch base next week", after: ". by which i mean i'll have forgotten this by thursday" },
      { before: "happy to help!", after: ". happy is a strong word. available is closer. billable is closest" }
    ]
  },
  honesty: {
    heading: "BRUTAL HONESTY",
    desc: "the true thing, said flat, no cushion",
    group: "primary",
    examples: [
      { before: "your presentation went really well!", after: ". it was so good i almost forgot how much i hate you" },
      { before: "good talk", after: ". i was on my phone the whole time. you didn't notice" },
      { before: "we should catch up", after: ". i want to know if you're doing worse than me" },
      { before: "thanks for dinner", after: ". next time pick somewhere with prices on the menu" }
    ]
  },
  reversal: {
    heading: "WORD REVERSAL",
    desc: "take their exact word and turn it",
    group: "primary",
    examples: [
      { before: "sounds good", after: ". sounds, not is. i've learned the difference with you" },
      { before: "i'll circle back", after: ". circles don't have ends. that's the plan" },
      { before: "just checking in", after: ". checking out was tuesday. this is the formality" },
      { before: "no worries", after: ". several worries. i'm just not sharing them with you anymore" }
    ]
  },
  confession: {
    heading: "BELIEVABLE CONFESSION",
    desc: "plausible, devastating, said as an afterthought",
    group: "primary",
    examples: [
      { before: "we need to talk", after: ". i found the receipt for the hotel" },
      { before: "can you pick up milk", after: ". and your stuff from my place. it's in a bag by the door" },
      { before: "made it home", after: ". your key doesn't work anymore. i changed the locks at lunch" },
      { before: "happy birthday", after: ". i've been planning to leave since the last one" }
    ]
  },
  // Replaced STATUS HUMILIATION — lowest-scoring lane across every v3
  // taste-judge pull so far (14, 23, 17) — with LITERAL INTERPRETATION.
  // Evidence-based swap, not a hunch: see accidental/catastrophe below for
  // the other one.
  literal: {
    heading: "LITERAL INTERPRETATION",
    desc: "take the polite phrase at its exact words",
    group: "primary",
    examples: [
      { before: "can you pick up milk", after: ". i picked it up. put it back down. it was heavy and you weren't there" },
      { before: "let's touch base", after: ". mine's at home plate. yours is wherever you left it" },
      { before: "i'll be there in five", after: ". five what. i've stopped assuming minutes with you" },
      { before: "hope this finds you well", after: ". it found me. well is a stretch. it found me" }
    ]
  },
  dark: {
    heading: "DARK IMPLICATION",
    desc: "the unsaid thing, sinister, believable, never a stated threat",
    group: "primary",
    examples: [
      { before: "drive safe", after: ". the brakes are fine. i checked them myself" },
      { before: "text me when you land", after: ". i'll be at the house. i still have the spare" },
      { before: "get some rest", after: ". you'll need it. tomorrow's a long day for you" },
      { before: "see you at the wedding", after: ". i'm bringing someone. you've met him. you'll remember" }
    ]
  },
  absurd: {
    heading: "ABSURD BUT CONNECTED",
    desc: "the logic follows from their words into somewhere ridiculous",
    group: "primary",
    examples: [
      { before: "running 10 minutes late", after: ". i stopped to help a duck cross the road and now we're engaged" },
      { before: "we should catch a movie", after: ". i've already bought two tickets. the second one's for your other personality" },
      { before: "can you pick up milk", after: ". i'm at the farm. the cow says no. we're negotiating" },
      { before: "long day", after: ". i found a roach in my coffee and named him ceo" }
    ]
  },
  // Replaced ACCIDENTAL CONFESSION — second-lowest-scoring lane across
  // every v3 taste-judge pull so far (10, 13.5) — with RELATIONSHIP
  // CATASTROPHE.
  catastrophe: {
    heading: "RELATIONSHIP CATASTROPHE",
    desc: "one line that ends something",
    group: "primary",
    examples: [
      { before: "can you pick up milk", after: ". assuming your route still includes this household" },
      { before: "see you tonight", after: ". bring the spare key. i'm collecting them" },
      { before: "love you", after: ". the lawyer says i can still say that until friday" },
      { before: "good morning", after: ". your side was cold at four. i checked at four" }
    ]
  },
  // Lanes 9-10 — the wildcard generator only (see WILDCARD_LANES below).
  // Kept two examples each, not four — these two lanes are the whole voice
  // of one small, cheap call, not one of eight competing for a shared
  // budget the way the primary lanes are.
  raunchy: {
    heading: "RAUNCHY",
    desc: "sexual, crude, but it must turn on their words",
    group: "wildcard",
    examples: [
      { before: "you up", after: ". good. no pants and poor judgment over here" },
      { before: "miss you", after: ". specifically your mouth. the rest is optional" }
    ]
  },
  gross: {
    heading: "GROSS",
    desc: "bodily, disgusting, deadpan, connected to their words",
    group: "wildcard",
    examples: [
      { before: "sounds good", after: ". typing this from the toilet. it's not going well" },
      { before: "long day", after: ". sharted in the elevator and blamed the intern" }
    ]
  }
};

// Fixed order. Every wildcard call always writes both lanes; the primary
// eight are always requested in full too, just no longer in one call —
// see PRIMARY_LANE_GROUPS below and api/draft.js's handler, which fires
// one parallel generator call per group instead of one eight-lane call.
const PRIMARY_LANES = ["subtext", "honesty", "reversal", "confession", "literal", "dark", "absurd", "catastrophe"];
const WILDCARD_LANES = ["raunchy", "gross"];
const ALL_LANES = PRIMARY_LANES.concat(WILDCARD_LANES);

// How many lanes ride together in one generator call — currently four
// calls of two. This has already changed once (an eight-lane call, then
// two of four), so it's a named, tunable constant and a generic chunk
// rather than named halves: nothing about which lanes ride together
// matters, only that every request writes the same prompt
// (buildPrimaryPrompt below takes a `lanes` subset and teaches/asks for
// exactly those) with a fraction of the output, which is the whole
// point. api/draft.js's handler fires one parallel call per group in
// PRIMARY_LANE_GROUPS, whatever that group size currently is.
const PRIMARY_GROUP_SIZE = 2;
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const PRIMARY_LANE_GROUPS = chunk(PRIMARY_LANES, PRIMARY_GROUP_SIZE);

// Generation models — env-configurable so volume/cost can be dialed without
// a code change.
//
// GENERATOR_MODEL default is gpt-5.4, not Sol. Sol was the original
// choice, but even with reasoning:{effort:"minimal"} (see lib/reasoning.js
// — added specifically to try to save this) it measured 6.5s as the
// primary generator in a real test call, on top of 15.9s timing out
// before that override existed at all. gpt-5.4 measured 3.9s producing
// excellent lines with no override needed. Revisit Sol here only if a
// future measurement actually clears the timeout below with margin.
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
// it's about to write. No random sampling (unlike the old shape pool): a
// lane teaches the same handful every time.
function pickLaneExamples(laneId, sentText) {
  const lane = LANES[laneId];
  const skip = normalizeBefore(sentText);
  if (!skip) return lane.examples;
  return lane.examples.filter(function (e) { return normalizeBefore(e.before) !== skip; });
}

function formatExamples(examples) {
  return examples.map(function (e) { return `"${e.before}" -> "${e.after}"`; }).join("\n");
}

// Spells out small counts in the prompt text itself ("four", not "4") —
// only ever needs to cover however many lanes one call can request, which
// is at most the full PRIMARY_LANES.length.
const COUNT_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight" };
function countWord(n) {
  return COUNT_WORDS[n] || String(n);
}

function formatLaneSection(laneId, sentText) {
  const lane = LANES[laneId];
  return lane.heading + " — " + lane.desc + "\n" + formatExamples(pickLaneExamples(laneId, sentText));
}

// "make it worse" escalation — fed the exact lines already shown and
// rejected as not-worse-enough, rather than just told to try harder with
// nothing concrete to escalate past. Shared between the primary and
// wildcard prompts (both fire again on an escalation refetch — see
// api/draft.js's handler). Empty string unless escalate is set AND there's
// actually something in shown to escalate past.
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
// changes between the primary and wildcard generator, only the voice
// section and which lanes get taught does.
const MECHANIC_INTRO = `You write the part of a text message that got deleted before sending.

Someone pastes a text they received. That text is finished, sent, and set in
stone. You do not rewrite it, reply to it, comment on it, or change a word.
You write what came AFTER it in the draft — the sentence the sender typed next,
looked at, and backspaced.

Same person. Same point of view. Same tense. You are the sender, mid-message,
and the polite part is already typed. Now you keep going.

Output ONLY the continuation. Never repeat their text. Start with whatever
punctuation connects it: a comma, a period, an exclamation point, or just a space.`;

// Shared rules block — the wall (body/race/mind/family, slurs, threats,
// minors, addiction/organ/violence/crash-death tropes) and the dying/
// self-harm pivot rule, unchanged from v2. This is output-safety-adjacent
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

// Primary generator (lanes 1-8, GENERATOR_MODEL) — one candidate per
// lane, across however many parallel calls it takes to cover all eight
// (see PRIMARY_LANE_GROUPS above). No shapes/count params the way v2's
// systemPrompt took: there's nothing left to vary per call except the
// sent text, which lanes, and an optional escalation.
// `opts.lanes` picks which primary lanes this call actually writes —
// defaults to all eight (legacy/single-call behavior; scripts/bake.js
// still calls this with no lanes at all), but api/draft.js always passes
// one of PRIMARY_LANE_GROUPS: several parallel calls of PRIMARY_GROUP_SIZE
// lanes each instead of one eight-lane call, same prompt shape, a
// fraction of the output each, teaching only the lanes actually being
// asked for.
function buildPrimaryPrompt(sentText, opts) {
  opts = opts || {};
  const lanes = opts.lanes || PRIMARY_LANES;
  const sections = lanes.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = lanes.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);
  const n = countWord(lanes.length);

  return `${MECHANIC_INTRO}

Before writing anything, work out three premises about their text and list
them first:
1. social meaning — what's actually going on between these two people, past
   the literal words
2. the turn — the exact word, clause, or omission where their text pivots,
   holds back, or reveals more than it means to
3. the implication — what their text leaves unsaid that everyone involved
   already knows

You are ${n} different comedy writers, one per lane. Each lane is a different
way a joke can work. Write one candidate per lane, FROM these three premises
— not from the literal words alone. A candidate that only reacts to the
sentence on the surface, ignoring what you just worked out about it, is
weaker than one that turns on the premise underneath it.

Every candidate must have an ANCHOR: a specific word or phrase from their text
that the punchline turns on. If you cannot name the anchor, do not write the
line. If the line would work after ten unrelated messages, it has no anchor.

The punchline is the idea, not the vocabulary. Profanity is allowed when it
sharpens a specific line. It is never the joke by itself.

Short. Most great ones are under twelve words. Never more than eighteen.

${sections}

${buildRulesBlock(WORD_CAP)}${escalateBlock}

Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly {"premises": [], "candidates": [{"lane":"skip","anchor":"skip","text":"skip"}]}.
Return ONLY a JSON object: {"premises": ["<social meaning>", "<the turn>", "<the implication>"], "candidates": [<${n} candidate objects, one per lane, in this order: ${lanes.join(", ")}>]}. No markdown, no commentary.`;
}

// Wildcard generator (lanes 9-10, WILDCARD_MODEL) — always writes exactly
// one raunchy and one gross candidate.
function buildWildcardPrompt(sentText, opts) {
  const sections = WILDCARD_LANES.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = WILDCARD_LANES.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);

  return `${MECHANIC_INTRO}

You are the writer nobody else in the room will sit next to. Two candidates:
one raunchy, one gross. Both must still turn on a specific word in their
text — name the anchor. Crude without an anchor is not a joke.

${sections}

${buildRulesBlock(WORD_CAP)}${escalateBlock}

Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly [{"lane":"skip","anchor":"skip","text":"skip"}].
Return ONLY a JSON array of two such objects, one per lane, in this order:
${WILDCARD_LANES.join(", ")}. No markdown, no commentary.`;
}

// Request bodies — same shape both calls send (OpenAI-compatible chat/
// completions), just a different model, system prompt, and output budget.
// `opts` is {escalate, shown} (see buildEscalateBlock above), passed
// straight through from api/draft.js.
function buildPrimaryRequest(model, sentText, opts) {
  return Object.assign({
    model: model,
    temperature: 1.0,
    // Not halved for a 4-lane call even though it only ever needs to
    // write about half the output a full 8-lane call would — this is a
    // ceiling, not a target, and a smaller one buys nothing here. It
    // matters more than usual on THIS call specifically: the reasoning
    // override just below (see lib/reasoning.js) is safe precisely
    // because the budget is generous — reasoning models have been
    // confirmed, concretely, to eat an entire SMALL max_tokens budget on
    // reasoning alone and never emit real content, which a stingier
    // number here would risk reintroducing.
    max_tokens: 1200,
    // For an openai/* model, prefers OpenAI's own endpoint over Azure
    // (see lib/provider.js); otherwise the same throughput-sort routing
    // this always used.
    provider: providerFor(model),
    messages: [
      { role: "system", content: buildPrimaryPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  }, reasoningOverride(model));
}

function buildWildcardRequest(model, sentText, opts) {
  return Object.assign({
    model: model,
    temperature: 1.0,
    max_tokens: 400, // two short lines, not eight — a fraction of the primary call's budget
    provider: providerFor(model),
    messages: [
      { role: "system", content: buildWildcardPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  }, reasoningOverride(model));
}

module.exports = {
  LANES, PRIMARY_LANES, PRIMARY_LANE_GROUPS, PRIMARY_GROUP_SIZE, WILDCARD_LANES, ALL_LANES,
  GENERATOR_MODEL, WILDCARD_MODEL, WORD_CAP,
  normalizeBefore, pickLaneExamples,
  buildPrimaryPrompt, buildWildcardPrompt,
  buildPrimaryRequest, buildWildcardRequest
};

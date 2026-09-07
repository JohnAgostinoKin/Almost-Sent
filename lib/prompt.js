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
// Every candidate a generator writes carries three things past the visible
// `text`: `lane` (which of these it's playing), `anchor` (the specific word
// or phrase in the sent text the punchline turns on — the model has to name
// it, not just imply it), and `mechanism` (a few words on how the anchor
// becomes the joke). The visitor only ever sees `text`; anchor and
// mechanism exist for lib/judge.js to check the model's homework against —
// a "connection test" that's no longer just a mechanical yes/no on the
// finished line, it's checking whether the claimed anchor actually is in
// the text and actually is what the line turns on.
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
  status: {
    heading: "STATUS HUMILIATION",
    desc: "where they actually rank, socially",
    group: "primary",
    examples: [
      { before: "congrats on the promotion", after: ". they gave it to you because dave said no" },
      { before: "great to meet you", after: ". i've already forgotten your name. it's on your badge, right?" },
      { before: "you were great tonight", after: ". your friend was better. she gave me her number" },
      { before: "let's do lunch", after: ". somewhere near your office. mine has a dress code" }
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
  accidental: {
    heading: "ACCIDENTAL CONFESSION",
    desc: "they reveal something about themselves without meaning to",
    group: "primary",
    examples: [
      { before: "i'm fine", after: ". is what i said right before i keyed your car" },
      { before: "sorry i missed your call", after: ". i watched it ring. all of it. i counted" },
      { before: "no offense", after: ". i rehearsed this in the mirror. twice. with hand gestures" },
      { before: "love you too", after: ". too is the word i'd fight about if i had the energy" }
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

// Fixed order, always requested in full — there's no "which lanes this
// call wants" question the way the old ACTIVE_SHAPES subset/exclude
// machinery had to answer; every primary call always writes all eight,
// every wildcard call always writes both.
const PRIMARY_LANES = ["subtext", "honesty", "reversal", "confession", "status", "dark", "absurd", "accidental"];
const WILDCARD_LANES = ["raunchy", "gross"];
const ALL_LANES = PRIMARY_LANES.concat(WILDCARD_LANES);

// Generation models — env-configurable so volume/cost can be dialed without
// a code change (see the section 1 brief's cost note: Sol is roughly $4 in
// / $20 out per million tokens, call it ~1.5c/pull across both generator
// calls at current token counts — the knobs below are what let that come
// back down to a legacy-model price if volume ever outruns the value).
const GENERATOR_MODEL = process.env.GENERATOR_MODEL || "openai/gpt-5.6-sol";
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
    "them. Not different — worse.\n\nAlready shown:\n" +
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

// Primary generator (lanes 1-8, GENERATOR_MODEL) — always writes exactly
// one candidate per lane, eight total. No shapes/count params the way v2's
// systemPrompt took: there's nothing left to vary per call except the sent
// text and an optional escalation.
function buildPrimaryPrompt(sentText, opts) {
  const sections = PRIMARY_LANES.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = PRIMARY_LANES.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);

  return `${MECHANIC_INTRO}

You are eight different comedy writers, one per lane. Each lane is a different
way a joke can work. Write one candidate per lane.

Every candidate must have an ANCHOR: a specific word or phrase from their text
that the punchline turns on. If you cannot name the anchor, do not write the
line. If the line would work after ten unrelated messages, it has no anchor.

The punchline is the idea, not the vocabulary. Profanity is allowed when it
sharpens a specific line. It is never the joke by itself.

Short. Most great ones are under twelve words. Never more than eighteen.

${sections}

${buildRulesBlock(WORD_CAP)}${escalateBlock}

Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "mechanism": "<a few words on how the anchor becomes the joke>", "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly [{"lane":"skip","anchor":"skip","mechanism":"skip","text":"skip"}].
Return ONLY a JSON array of eight such objects, one per lane, in this order:
${PRIMARY_LANES.join(", ")}. No markdown, no commentary.`;
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

Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "mechanism": "<a few words on how the anchor becomes the joke>", "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly [{"lane":"skip","anchor":"skip","mechanism":"skip","text":"skip"}].
Return ONLY a JSON array of two such objects, one per lane, in this order:
${WILDCARD_LANES.join(", ")}. No markdown, no commentary.`;
}

// Request bodies — same shape both calls send (OpenAI-compatible chat/
// completions), just a different model, system prompt, and output budget.
// `opts` is {escalate, shown} (see buildEscalateBlock above), passed
// straight through from api/draft.js.
function buildPrimaryRequest(model, sentText, opts) {
  return {
    model: model,
    temperature: 1.0,
    max_tokens: 1200,
    // Tells OpenRouter to route this model id to whichever upstream
    // provider is currently fastest (by throughput) rather than its
    // default preference order.
    provider: { sort: "throughput" },
    messages: [
      { role: "system", content: buildPrimaryPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  };
}

function buildWildcardRequest(model, sentText, opts) {
  return {
    model: model,
    temperature: 1.0,
    max_tokens: 400, // two short lines, not eight — a fraction of the primary call's budget
    provider: { sort: "throughput" },
    messages: [
      { role: "system", content: buildWildcardPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  };
}

module.exports = {
  LANES, PRIMARY_LANES, WILDCARD_LANES, ALL_LANES,
  GENERATOR_MODEL, WILDCARD_MODEL, WORD_CAP,
  normalizeBefore, pickLaneExamples,
  buildPrimaryPrompt, buildWildcardPrompt,
  buildPrimaryRequest, buildWildcardRequest
};

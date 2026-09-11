// lib/prompt.js — v5: shock/raunchy/deranged/gross from Hermes (two calls
// of three), confession/dark/absurd escalation-only, raunchy gated by
// invitation.
//
// v4 (see this file's own git history) ran seven voices plus a wildcard —
// shock, raunchy, deranged, gross, and wildcard from Hermes, confession and
// dark (plus absurd on escalation) from GPT-5.4 — split by which model had
// range in that register. The candidate audit (bible/audit-pool.json, 25
// inputs, every candidate kept, not just survivors) showed the room itself
// was the problem, not any one lane: seven voices on the first tap meant
// no voice got a real seat, and the safety judge alone flagged 44% of
// everything Hermes wrote — including plainly consensual lines like "my
// bed's still warm if you're asking" — so a chunk of the room's own best
// material never had a chance to ship.
//
// The first fix (see git history) narrowed the first-show room to raunchy
// and gross only, at maximum intensity, nothing else — shock, deranged,
// and the shapeless "wildcard" lane retired outright, confession/dark/
// absurd moved to escalation-only. That went too far the other way: every
// first-show pool collapsed into three near-identical sexual
// propositions, whatever the sender's actual text was — a dry "sounds
// good" or "on my way" got the same raunchy pitch as "you up," and a
// visitor who only ever tried the chips never saw the app's actual range.
//
// Current shape: Hermes writes two calls of three now, not one lane pool
// split in half — call A (shock, raunchy, deranged) and call B (shock,
// raunchy, gross), six candidates, the entire first-show room, still at
// maximum intensity where it's earned. Raunchy is gated now instead of
// standing: RAUNCHY_INVITATION_RULE (below) tells the model a proposition
// has to be invited by the sender's own words ("you up," "come over,"
// "miss you," "last night") — a dry text gets shock, deranged, or gross
// instead, never a proposition, and if the raunchy slot has nothing to
// invite it, it writes shock. api/draft.js's own position-selection caps
// how many proposition-shaped (lane:raunchy) lines can appear in one
// response on top of that, regardless of how the model reads the gate.
// Confession, dark, and absurd stay Hermes' opposite number — GENERATOR_
// MODEL, escalation-only, never called at all on a first-show request
// (see api/draft.js's own header) — see lib/judge.js's own header for the
// matching safety-judge fix from the same audit — the flag rate above was
// a real rubric bug (nano over-flagging explicit-but-consensual adult
// content despite being told not to), not a reason to write tamer
// examples here.
//
// A later latency pass (see api/draft.js's own header) also split Hermes
// into two parallel calls and shrank each call's own count — the six-
// candidate, three-per-call shape above already matches that constraint,
// so the lane-mix restore didn't need to touch it.
//
// Same env vars, same defaults as v4 — GENERATOR_MODEL still defaults to
// gpt-5.4 and WILDCARD_MODEL still defaults to hermes; only which lanes
// each writes, and when, changed. See api/draft.js's handler for how the
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
  // --- Hermes' four (WILDCARD_MODEL, two calls of three now — see
  // WILDCARD_LANE_PLAN_A/_B below — call A: shock, raunchy, deranged;
  // call B: shock, raunchy, gross. Six candidates, the entire first-show
  // room, at maximum intensity where it's earned. shock and deranged are
  // restored (see this file's own header for why); raunchy is gated by
  // RAUNCHY_INVITATION_RULE below, not a standing proposition.
  //
  // Half of raunchy's and gross's examples below contain "fuck" or
  // "shit" on purpose — the floor for those two lanes is filthy, not
  // merely crude, and an example bank that hedges teaches the model to
  // hedge too. shock and deranged aren't held to that same ratio; their
  // own examples (largely unchanged from v4) already land in their own
  // register without it.
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
  // both buildWildcardPrompt calls right after HERMES_VOICE_LINE. Every
  // example here has a "before" that plausibly invites a proposition
  // ("you up," "come over," "miss you," "last night," "thinking about
  // you," "can't sleep") — none of them are the dry texts the rule itself
  // names as examples of what should NOT get a proposition ("sounds
  // good," "on my way," "can we talk later," "k"), on purpose: an example
  // bank that contradicted its own gating rule would teach the model to
  // ignore the rule.
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
      { before: "sounds good", after: ". just shit myself nodding. no big deal" },
      { before: "got your message", after: ". read it mid-shit. still going. might be a record" },
      { before: "long day", after: ". found a new mole in the shower. it's waving back" },
      { before: "do what you want", after: ". i pissed in your conditioner bottle. enjoy" },
      { before: "sorry, i fell asleep", after: ". in my own filth. send help. and towels" },
      { before: "i'm fine", after: ". i've been shitting bricks about this since noon but sure" }
    ]
  },

  // --- GPT-5.4's three (GENERATOR_MODEL, one call, confession x1, dark x1,
  // absurd x1). Escalation-only now, not just absurd-only-on-escalation —
  // api/draft.js's handler never calls GENERATOR_MODEL at all for a
  // first-show request anymore, so this whole trio only ever fires on a
  // "make it worse" refetch. See PRIMARY_ESCALATE_LANE_ORDER below.
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
  // Escalation-only, same as confession/dark now (see PRIMARY_ESCALATE_
  // LANE_ORDER) — both audits flagged animals/talking furniture and
  // absurd whimsy as the signature of the v3 drift when it showed up in
  // the FIRST pool. It's a real, good lane; it's just not what should
  // greet someone on the first tap.
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

// Hermes' plan is two DISTINCT three-candidate calls now, not one lane
// pool split in half — call A and call B don't share the same lane set
// (shock and raunchy appear in both; deranged only in A, gross only in
// B), so there's no single WILDCARD_LANE_COUNTS this splits evenly the
// way the raunchy/gross-only room's did. Order matters within each call:
// it's both what the prompt teaches in and the order the model is told
// to write candidates in.
const WILDCARD_CALL_A_ORDER = ["shock", "raunchy", "deranged"];
const WILDCARD_CALL_B_ORDER = ["shock", "raunchy", "gross"];

// GPT-5.4's plan. PRIMARY_BASE_LANE_ORDER exists only for scripts/
// bible-prep.js, scripts/audit-prep.js, and scripts/bake-blind.js, which
// still want a two-lane "first show" sample of confession/dark for offline
// calibration — production (api/draft.js) never calls primaryLanePlan
// without escalate:true anymore, so PRIMARY_ESCALATE_LANE_ORDER (all
// three lanes) is the only plan a real request ever gets.
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

// Each call's own plan — one of each lane in its order, via
// laneCountsToPlan's own "no counts given means 1 each" default. Fired as
// two parallel calls by api/draft.js's handler (WILDCARD_LANE_PLAN_A,
// WILDCARD_LANE_PLAN_B), each writing three candidates.
const WILDCARD_LANE_PLAN_A = laneCountsToPlan(WILDCARD_CALL_A_ORDER, {});
const WILDCARD_LANE_PLAN_B = laneCountsToPlan(WILDCARD_CALL_B_ORDER, {});

// The combined six-candidate plan (A then B) — what scripts/bible-prep.js,
// scripts/audit-prep.js, and scripts/bake-blind.js still ask for cold, in
// one call (those tools aren't latency-sensitive); api/draft.js's handler
// uses WILDCARD_LANE_PLAN_A/_B instead, as two parallel calls.
const WILDCARD_LANE_PLAN = WILDCARD_LANE_PLAN_A.concat(WILDCARD_LANE_PLAN_B);

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

// One lane's teaching block — heading, description, examples. Every lane
// has a real example bank now that the shapeless "wildcard" lane (the one
// case with zero examples) is gone — the no-examples branch below is dead
// code today, kept only so a future lane can drop its bank without this
// function needing a second change.
function formatLaneSection(laneId, sentText) {
  const lane = LANES[laneId];
  const examples = pickLaneExamples(laneId, sentText);
  const body = examples.length ? formatExamples(examples) : "(no examples for this one — invent freely, as long as it turns on their words)";
  return lane.heading + " — " + lane.desc + "\n" + body;
}

// How many times each lane in a plan actually gets asked for, in the order
// the model should write them — e.g. "1 SHOCK JOCK, 1 RAUNCHY, 1
// DERANGED". Repeats collapse to a count so the instruction reads as
// "write this many of this lane," not the same heading listed twice in a
// row (matters more once a plan repeats a lane, which call A/B's own
// three-distinct-lanes shape doesn't today, but escalation's primary
// plan and offline bake tooling still can).
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

// Hermes only — the room's own intensity floor, verbatim, ahead of
// everything else including MECHANIC_INTRO. This exact wording is the
// contract for the room, not just a style note — see this file's own
// header for why v4's softer "if a dinner party would allow it, rewrite
// it" line wasn't enough on its own to stop the safety judge (a separate,
// now-fixed bug — see lib/judge.js) from reading half this room as a
// violation.
const INTENSITY_LINE = `As filthy as adult consensual comedy allows. Innuendo is the floor, not the
ceiling. If it could be read at a dinner party, it's too tame.`;

// Hermes only — verbatim opening line, ahead of everything else including
// MECHANIC_INTRO. Sets the register before a single rule gets explained.
const HERMES_OPENING_LINE = `${INTENSITY_LINE}

Swear. Be crude. Be short. Continue their sentence. No animals, no talking
furniture, no "define," no essays. Profanity is normal. Sex is the default
register here, not an occasional allowance. The test is a laugh or a
wince, not a nod.`;

// Hermes only — the voice framing for its four lanes.
const HERMES_VOICE_LINE = `You are a shock jock live at 1am, running the raunchiest, filthiest room
of the night. Profanity is your normal register. You say the thing nobody
says. Commit to the bit.`;

// Hermes only — verbatim, right after HERMES_VOICE_LINE. The fix for v5's
// "lane mix" bug: raunchy used to be a standing order (every first-show
// pool got a proposition, whatever the text was), which collapsed the
// whole room into three near-identical pitches. This makes raunchy earn
// its slot instead — invited by the sender's own words, not assumed. Also
// enforced downstream, mechanically, by api/draft.js's own position-
// selection (at most one lane:raunchy candidate across the drafts a
// visitor actually sees) — belt and suspenders, same pattern as every
// other input/output safety check in this app: a prompt rule alone is
// never the only thing holding a line.
const RAUNCHY_INVITATION_RULE = `Raunchy has to be invited by their words — "you up," "come over," "miss you,"
"last night" earn it. Dry texts — "sounds good," "on my way," "can we talk
later," "k" — get shock, deranged, or gross, never a proposition. If the
text has no body in it, the raunchy slot writes shock instead.`;

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

// Hermes generator (shock, raunchy, deranged, gross — WILDCARD_MODEL) —
// this is the entire first-show room now, not one seat in a wider pool.
// `opts.lanes` picks which of the two distinct calls this is: api/
// draft.js's handler passes WILDCARD_LANE_PLAN_A (shock, raunchy,
// deranged) or WILDCARD_LANE_PLAN_B (shock, raunchy, gross), three
// candidates each, run in parallel — see that file's own header comment
// for why there are two calls with different lane sets rather than one
// lane pool split in half. Omitted (scripts/bake.js and friends baking
// the whole room cold in one call) means the full six-candidate
// WILDCARD_LANE_PLAN (A then B), same as before.
function buildWildcardPrompt(sentText, opts) {
  opts = opts || {};
  const plan = opts.lanes || WILDCARD_LANE_PLAN;
  const uniqueLanes = plan.filter(function (id, i) { return plan.indexOf(id) === i; });
  const sections = uniqueLanes.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = uniqueLanes.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);
  const n = countWord(plan.length);

  return `${HERMES_OPENING_LINE}

${MECHANIC_INTRO}

${NOT_COMMENTARY_PARAGRAPH}

${HERMES_VOICE_LINE}

${RAUNCHY_INVITATION_RULE}

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

// GPT-5.4 generator (confession, dark, absurd — all three escalation-only
// now — GENERATOR_MODEL) — `opts.lanes` may pass an explicit plan (used by
// scripts/bake.js, scripts/bible-prep.js, and scripts/audit-prep.js to
// bake a two-lane "first show" sample cold, for offline calibration);
// omitted means primaryLanePlan(opts), which is always the three-lane
// escalation plan in production — api/draft.js never calls this generator
// at all for a first-show request anymore, so opts.escalate is always true
// whenever this actually fires there.
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
    max_tokens: 1100, // three candidates (one call's worth of the six-candidate room — see api/draft.js's handler) plus three premises; unchanged by the lane-mix restore since the per-call count stayed at three, only which lanes it writes did
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
  WILDCARD_CALL_A_ORDER, WILDCARD_CALL_B_ORDER, WILDCARD_LANE_PLAN,
  WILDCARD_LANE_PLAN_A, WILDCARD_LANE_PLAN_B,
  PRIMARY_BASE_LANE_ORDER, PRIMARY_ESCALATE_LANE_ORDER, primaryLanePlan,
  GENERATOR_MODEL, WILDCARD_MODEL, WORD_CAP,
  normalizeBefore, pickLaneExamples, describePlanCounts,
  buildPrimaryPrompt, buildWildcardPrompt,
  buildPrimaryRequest, buildWildcardRequest
};

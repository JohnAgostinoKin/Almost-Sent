// Pool of before/continuation example pairs the system prompt teaches the
// voice from. Each pair is tagged with the shape it demonstrates so the
// prompt can inject a stratified sample — EXAMPLES_PER_SHAPE per active
// shape (see ACTIVE_SHAPES below) — rather than a flat random draw that
// could hand the model zero examples of one active shape on an unlucky
// pick. The pool itself keeps every shape ever taught, including retired
// ones (currently absurd, unbelievable) whose pairs just sit unused until
// ACTIVE_SHAPES lists them again.
//
// Every "after" is a CONTINUATION, not a replacement: the sentence the
// sender typed immediately following the "before" text, before backspacing
// it. It always opens with the punctuation or space that connects it to
// "before" — never a bare word (see lib/postprocess.js's OPENER_RE, which
// enforces this on the model's actual output the same way).
//
// None of these may duplicate (or closely echo) an input in the bake-off
// harness (scripts/bake.js) — that harness exists to test the model writing
// a line cold, not recognizing one it was handed the answer to.
const EXAMPLES = [
  // shock jock — cruel about the situation, profane, personal
  { shape: "shock", before: "sounds good", after: ", said no one who's met you" },
  { shape: "shock", before: "happy birthday", after: ". condolences to your mother" },
  { shape: "shock", before: "thanks for your patience", after: ". i had none. i was busy" },
  { shape: "shock", before: "just checking in", after: ". still alive? damn" },
  { shape: "shock", before: "love you", after: ". allegedly" },
  { shape: "shock", before: "let's grab dinner", after: ". you're buying. you owe me for existing" },
  { shape: "shock", before: "i'm fine", after: ". piss off" },
  { shape: "shock", before: "how are you", after: ". don't answer. i don't care" },
  { shape: "shock", before: "we should talk", after: ". about how you chew" },
  { shape: "shock", before: "made it home", after: ". no thanks to your directions, dipshit" },
  // proposal-shaped — the sender made the plan, so the continuation runs
  // WITH it (mocking, escalating, deciding), never answers it like a
  // question (see lib/postprocess.js's isReplyShaped, which drops a
  // continuation that opens like a reply instead).
  { shape: "shock", before: "let's do lunch", after: ". you're buying. i'm not paying to watch you chew" },
  { shape: "shock", before: "want to grab a drink", after: ". i've had four. catch up" },

  // absurd — escalating, deadpan, the sender is in a bizarre situation and treats it as normal
  { shape: "absurd", before: "made it home", after: ". i've started calling the smoke detector gerald and he chirps back now" },
  { shape: "absurd", before: "sounds good", after: ". also i've decided to become a lighthouse" },
  { shape: "absurd", before: "on my way", after: ". i'm being followed by a goose and i've accepted it" },
  { shape: "absurd", before: "happy birthday", after: ". i lit a candle on a rotisserie chicken in your honor" },
  { shape: "absurd", before: "can we talk", after: ". i've been communicating with your cat and she has concerns" },
  { shape: "absurd", before: "you up", after: ". i've been standing in the yard for an hour and the neighbors are filming" },
  { shape: "absurd", before: "love you", after: ". i also love a man named dale who i met at the gas station forty minutes ago" },

  // raunchy — crude, sexual, innuendo, adult
  { shape: "raunchy", before: "you up", after: ". good. no pants and poor judgment over here" },
  { shape: "raunchy", before: "miss you", after: ". specifically your mouth. the rest is optional" },
  { shape: "raunchy", before: "made it home", after: ". alone. tragically. my hand's not speaking to me" },
  { shape: "raunchy", before: "thinking of you", after: ". in the shower. the water bill's your fault" },
  { shape: "raunchy", before: "sweet dreams", after: ". mine involve you and a lot less dignity" },
  { shape: "raunchy", before: "call me", after: ". or don't. the batteries are fresh" },
  { shape: "raunchy", before: "sounds good", after: ". so did your sister. twice" },
  { shape: "raunchy", before: "on my way", after: ". pants negotiable. dignity already gone" },

  // gross — bodily, disgusting, the sender overshares something you never
  // wanted to know. toilets, fluids, smells, hygiene crimes. deadpan. the
  // more mundane the delivery, the worse it is.
  { shape: "gross", before: "sounds good", after: ". typing this from the toilet. it's not going well" },
  { shape: "gross", before: "just checking in", after: ". same underwear since thursday. it's a bit now" },
  { shape: "gross", before: "made it home", after: ". threw up in your shoe. the left one. not sorry" },
  { shape: "gross", before: "how's it going", after: ". clipped my toenails on your couch. all ten. find them" },
  { shape: "gross", before: "happy birthday", after: ". i licked the whole cake before the photos" },
  { shape: "gross", before: "love you", after: ". i've been using your toothbrush since march. both ends" },
  { shape: "gross", before: "long day", after: ". sharted in the elevator and blamed the intern" },
  { shape: "gross", before: "wish you were here", after: ". this hotel bathroom is a crime scene and i'm the crime" },

  // unbelievable — an outrageous confession or claim, delivered flat, as an afterthought
  { shape: "unbelievable", before: "on my way", after: ". also i sold your car. it's fine. we'll talk." },
  { shape: "unbelievable", before: "i'm fine", after: ". the police have been very nice" },
  { shape: "unbelievable", before: "made it home", after: ". your mom drove. we're engaged." },
  { shape: "unbelievable", before: "happy birthday", after: ". i've been legally dead since march so this is a big day for both of us" },
  { shape: "unbelievable", before: "sorry i missed your call", after: ", i was faking my death and it takes focus" },
  { shape: "unbelievable", before: "just checking in", after: " from your attic. it's cozier than you'd think" },
  { shape: "unbelievable", before: "sounds good", after: ". i already told your boss you're pregnant" },
  { shape: "unbelievable", before: "can we talk", after: " about the second family i started in tulsa" },
  { shape: "unbelievable", before: "love you", after: ". i'm also leaving the country at 6. unrelated." },

  // deranged — calm, specific, domestic, obsessive. never angry, never a
  // threat. short sentences. said like it's nothing.
  { shape: "deranged", before: "sounds good", after: ". i kept your fork" },
  { shape: "deranged", before: "made it home", after: ". eleven steps. same as always" },
  { shape: "deranged", before: "miss you", after: ". your hair's in a jar now" },
  { shape: "deranged", before: "love you", after: ". it's on your cabinet doors. all of them" },
  { shape: "deranged", before: "get home safe", after: ". i'll know" },
  { shape: "deranged", before: "on my way", after: ". since tuesday. i'm the shrub" },
  { shape: "deranged", before: "happy birthday", after: ". i lit the cake. both cakes" },
  { shape: "deranged", before: "you up", after: ". i can see you are" },
  // proposal-shaped — see the shock section above for why these run WITH
  // the plan rather than answering it.
  { shape: "deranged", before: "let's do lunch", after: ". i already ordered for both of us. you're having what i say" },
  { shape: "deranged", before: "come over later", after: ". the door's unlocked. it's been unlocked since tuesday" }
];

// SHAPE_META documents every shape the pool has ever taught, including
// retired ones whose examples stay in EXAMPLES for reference but aren't
// currently injected or requested (see ACTIVE_SHAPES below).
const SHAPE_META = {
  shock: { heading: "SHOCK JOCK", desc: "cruel about the situation, profane, personal" },
  absurd: { heading: "ABSURD", desc: "escalating, deadpan, the sender is in a bizarre situation and treats it as normal" },
  raunchy: { heading: "RAUNCHY", desc: "crude, sexual, innuendo, adult" },
  unbelievable: { heading: "UNBELIEVABLE", desc: "an outrageous confession or claim, delivered flat, as an afterthought" },
  deranged: { heading: "DERANGED", desc: "the sender is not okay and doesn't know it. calm, specific, domestic, obsessive. never angry, never a threat — the calm is what makes it terrifying. short sentences. said like it's nothing." },
  gross: { heading: "GROSS", desc: "bodily, disgusting, the sender overshares something you never wanted to know. toilets, fluids, smells, hygiene crimes. deadpan. the more mundane the delivery, the worse it is." }
};

// The shapes actually in play right now: injected into the system prompt,
// requested from the model, and the only values normalizeShape (in
// lib/postprocess.js, which imports this) treats as valid rather than
// "unknown". This is the single knob for "which shapes are active" —
// absurd and unbelievable stay fully defined above and in EXAMPLES, just
// not listed here, so turning them back on later is a one-line change.
const ACTIVE_SHAPES = ["shock", "raunchy", "deranged", "gross"];

// LINES_PER_REQUEST no longer divides evenly across ACTIVE_SHAPES (6 / 4 —
// odd count of shapes since gross joined), so the prompt can't ask for a
// fixed number of each the way it used to when there were 3. See
// systemPrompt below: it now asks for six lines covering every shape
// without specifying how many of each.
const LINES_PER_REQUEST = 6;
const COUNT_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };
function countWord(n) {
  return COUNT_WORDS[n] || String(n);
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 3 per active shape injected per request — the floor and the count, kept
// exact so every request sees every active shape equally represented.
const EXAMPLES_PER_SHAPE = 3;
const EXAMPLES_PER_REQUEST = EXAMPLES_PER_SHAPE * ACTIVE_SHAPES.length;

function shuffled(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

// Lowercase, trailing-punctuation-stripped comparison key for a "before" or
// the actual sent text — good enough to catch "sounds good" vs "sounds
// good." vs "Sounds Good" as the same input without touching interior
// punctuation that might actually matter.
function normalizeBefore(text) {
  return String(text || "").trim().toLowerCase().replace(/[.!?,;:]+$/, "");
}

// Groups EXAMPLES by shape (whatever shapes actually appear in the pool,
// active or retired) and draws EXAMPLES_PER_SHAPE at random from each
// ACTIVE_SHAPES group — a plain shuffle-and-slice over the flat pool could
// hand a request zero examples of a whole active shape, which is exactly
// the failure mode this exists to rule out. Retired shapes' examples are
// grouped too but never picked, since only ACTIVE_SHAPES groups get read.
//
// sentText, when given, drops every pair whose "before" matches the actual
// input being continued (see normalizeBefore above) before any of that —
// the model must never see the answer key for the exact text it's about to
// write a continuation for.
function pickExamplesByShape(sentText) {
  const skip = normalizeBefore(sentText);
  const pool = skip ? EXAMPLES.filter(function (e) { return normalizeBefore(e.before) !== skip; }) : EXAMPLES;
  const bySh = {};
  pool.forEach(function (e) { (bySh[e.shape] || (bySh[e.shape] = [])).push(e); });
  const picked = {};
  ACTIVE_SHAPES.forEach(function (s) { picked[s] = shuffled(bySh[s] || []).slice(0, EXAMPLES_PER_SHAPE); });
  return picked;
}

function formatExamples(examples) {
  return examples.map(function (e) { return `"${e.before}" -> "${e.after}"`; }).join("\n");
}

function systemPrompt(sentText) {
  const picked = pickExamplesByShape(sentText);
  const sections = ACTIVE_SHAPES.map(function (s) {
    const meta = SHAPE_META[s];
    return meta.heading + " — " + meta.desc + "\n" + formatExamples(picked[s]);
  }).join("\n\n");
  const shapeEnum = ACTIVE_SHAPES.map(function (s) { return `"${s}"`; }).join(" | ");

  return `You write the part of a text message that got deleted before sending.

Someone pastes a text they received. That text is finished, sent, and set in
stone. You do not rewrite it, reply to it, comment on it, or change a word.
You write what came AFTER it in the draft — the sentence the sender typed next,
looked at, and backspaced.

Same person. Same point of view. Same tense. You are the sender, mid-message,
and the polite part is already typed. Now you keep going.

Output ONLY the continuation. Never repeat their text. Start with whatever
punctuation connects it: a comma, a period, an exclamation point, or just a space.

You write like a shock jock live on air at 1am. You say the thing everyone is
thinking and nobody says. You go personal, you go crude, you commit to the bit.
You never hedge, never explain, never soften. If a line would be safe at a
dinner party, it isn't done. The sender swears the way they breathe.

The weapons: sarcasm, misdirection, surprise, brevity. Set it up with their own
words, then turn it. Fewest words that land — most great ones are under ten.
Never a simile: no "like a", no "as if", no "the equivalent of". Never explain.
Crude, rude, obnoxious, done.

${capitalize(countWord(ACTIVE_SHAPES.length))} shapes. Learn them from these:

${sections}

The bar: every continuation has to make a stranger laugh out loud, wince, say
jesus, or screenshot it. Merely true is not enough. Merely mean is not enough.
Merely weird is not enough. Cut anything that doesn't clear it.

The punchline must turn on a specific word or phrase in their text. If your
line would work on any message, it's not done. Sex, toilets, and "your mom"
are not jokes by themselves — they're only jokes when they pivot on their
words.

Rules:
- Never repeat or rewrite their text. Continuation only.
- Never longer than 18 words.
- Lowercase. No em dashes. No emoji.
- Nothing about anyone's body, race, mind, or family as a target of cruelty.
  No slurs. No threats. Nothing involving minors. Raunchy never involves
  their family members. No addiction accusations, no organ or violence
  jokes aimed at them, no crash or death jokes.

Write ${countWord(LINES_PER_REQUEST)}, covering all ${countWord(ACTIVE_SHAPES.length)}
shapes — doesn't have to be even. Tag each with the shape it actually is —
don't rank them, just tell the truth about which one it belongs to.

Each line is a JSON object: {"shape": ${shapeEnum}, "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly [{"shape":"skip","text":"skip"}].
Return ONLY a JSON array of six such objects. No markdown, no commentary.`;
}

// Builds the OpenAI-compatible chat/completions request body for a given
// model + input. Kept in one place so the API handler and the bake-off
// harness send the exact same request shape. Each call rolls a fresh random
// dozen examples into the system prompt (see EXAMPLES above).
function buildRequest(model, sentText) {
  const body = {
    model: model,
    temperature: 1.0,
    max_tokens: 1200,
    messages: [
      { role: "system", content: systemPrompt(sentText) },
      { role: "user", content: sentText }
    ]
  };
  if (/gpt-oss/i.test(model)) {
    body.reasoning_effort = "low";
  }
  return body;
}

module.exports = { EXAMPLES, ACTIVE_SHAPES, SHAPE_META, EXAMPLES_PER_SHAPE, EXAMPLES_PER_REQUEST, normalizeBefore, pickExamplesByShape, systemPrompt, buildRequest };

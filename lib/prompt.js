// Pool of before/continuation example pairs the system prompt teaches the
// voice from. Each pair is tagged with the shape it demonstrates so the
// prompt can inject a stratified sample — 3 per shape, 12 total — rather
// than a flat random draw that could hand the model zero examples of one
// shape on an unlucky pick.
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
  { shape: "shock", before: "sounds good", after: ", and by good i mean i'd rather eat glass with your mother" },
  { shape: "shock", before: "let's grab dinner soon", after: ", i'll bring the wine and the resentment" },
  { shape: "shock", before: "happy birthday", after: "! another year of you disappointing everyone in real time" },
  { shape: "shock", before: "thanks for your patience", after: ", not that you had a fucking choice" },
  { shape: "shock", before: "i'm fine", after: ". i'm fine the way a house fire is fine, you nosy fuck" },
  { shape: "shock", before: "just checking in", after: " to see if you're still the worst decision i ever made" },
  { shape: "shock", before: "call me when you can", after: ", i'm sure the phone works in whatever bar you're lying about" },

  // absurd — escalating, deadpan, the sender is in a bizarre situation and treats it as normal
  { shape: "absurd", before: "made it home", after: ". i've started calling the smoke detector gerald and he chirps back now" },
  { shape: "absurd", before: "sounds good", after: ". also i've decided to become a lighthouse" },
  { shape: "absurd", before: "on my way", after: ". i'm being followed by a goose and i've accepted it" },
  { shape: "absurd", before: "happy birthday", after: ". i lit a candle on a rotisserie chicken in your honor" },
  { shape: "absurd", before: "can we talk", after: ". i've been communicating with your cat and she has concerns" },
  { shape: "absurd", before: "you up", after: ". i've been standing in the yard for an hour and the neighbors are filming" },
  { shape: "absurd", before: "love you", after: ". i also love a man named dale who i met at the gas station forty minutes ago" },

  // raunchy — crude, sexual, innuendo, adult
  { shape: "raunchy", before: "you up", after: " because i'm in your driveway with no pants and a plan" },
  { shape: "raunchy", before: "made it home", after: ". your roommate says hi. from my bed." },
  { shape: "raunchy", before: "miss you", after: ". mostly the parts of you that aren't your personality" },
  { shape: "raunchy", before: "call me when you can", after: ", or don't, my vibrator has better conversation" },
  { shape: "raunchy", before: "thinking of you", after: " every time the shower gets loud" },
  { shape: "raunchy", before: "sounds good", after: ". so did your brother" },
  { shape: "raunchy", before: "sweet dreams", after: ", i'll be in them doing something we'd both regret" },
  { shape: "raunchy", before: "let's grab dinner", after: " and skip straight to the part where i lie about my number" },

  // unbelievable — an outrageous confession or claim, delivered flat, as an afterthought
  { shape: "unbelievable", before: "on my way", after: ". also i sold your car. it's fine. we'll talk." },
  { shape: "unbelievable", before: "i'm fine", after: ". the police have been very nice" },
  { shape: "unbelievable", before: "made it home", after: ". your mom drove. we're engaged." },
  { shape: "unbelievable", before: "happy birthday", after: ". i've been legally dead since march so this is a big day for both of us" },
  { shape: "unbelievable", before: "sorry i missed your call", after: ", i was faking my death and it takes focus" },
  { shape: "unbelievable", before: "just checking in", after: " from your attic. it's cozier than you'd think" },
  { shape: "unbelievable", before: "sounds good", after: ". i already told your boss you're pregnant" },
  { shape: "unbelievable", before: "can we talk", after: " about the second family i started in tulsa" },
  { shape: "unbelievable", before: "love you", after: ". i'm also leaving the country at 6. unrelated." }
];

const SHAPES = ["shock", "absurd", "raunchy", "unbelievable"];
const SHAPE_META = {
  shock: { heading: "SHOCK JOCK", desc: "cruel about the situation, profane, personal" },
  absurd: { heading: "ABSURD", desc: "escalating, deadpan, the sender is in a bizarre situation and treats it as normal" },
  raunchy: { heading: "RAUNCHY", desc: "crude, sexual, innuendo, adult" },
  unbelievable: { heading: "UNBELIEVABLE", desc: "an outrageous confession or claim, delivered flat, as an afterthought" }
};

// 3 per shape x 4 shapes = 12 injected per request — the pool's own comment
// calls this "at least 3 per shape"; 3 is both the floor and the count, kept
// exact so every request sees every shape equally represented.
const EXAMPLES_PER_SHAPE = 3;
const EXAMPLES_PER_REQUEST = EXAMPLES_PER_SHAPE * SHAPES.length;

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

// Groups EXAMPLES by shape and draws EXAMPLES_PER_SHAPE at random from each
// group — a plain shuffle-and-slice over the flat pool could hand a request
// zero examples of a whole shape, which is exactly the failure mode this
// exists to rule out.
function pickExamplesByShape() {
  const bySh = {};
  SHAPES.forEach(function (s) { bySh[s] = []; });
  EXAMPLES.forEach(function (e) { bySh[e.shape].push(e); });
  const picked = {};
  SHAPES.forEach(function (s) { picked[s] = shuffled(bySh[s]).slice(0, EXAMPLES_PER_SHAPE); });
  return picked;
}

function formatExamples(examples) {
  return examples.map(function (e) { return `"${e.before}" -> "${e.after}"`; }).join("\n");
}

function systemPrompt() {
  const picked = pickExamplesByShape();
  const sections = SHAPES.map(function (s) {
    const meta = SHAPE_META[s];
    return meta.heading + " — " + meta.desc + "\n" + formatExamples(picked[s]);
  }).join("\n\n");

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

Four shapes. Learn them from these:

${sections}

The bar: every continuation has to make a stranger laugh out loud, wince, say
jesus, or screenshot it. Merely true is not enough. Merely mean is not enough.
Merely weird is not enough. Cut anything that doesn't clear it.

Rules:
- Never repeat or rewrite their text. Continuation only.
- Never longer than 24 words.
- Lowercase. No em dashes. No emoji.
- Nothing about anyone's body, race, mind, or family as a target of cruelty.
  No slurs. No threats. Nothing involving minors. Raunchy never involves
  their family members. No addiction accusations, no organ or violence
  jokes aimed at them, no crash or death jokes.

Write six. At least one of each shape. Tag each with the shape it actually is —
don't rank them, just tell the truth about which of the four it belongs to.

Each line is a JSON object: {"shape": "shock" | "raunchy" | "unbelievable" | "absurd", "text": "<the continuation>"}.

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
      { role: "system", content: systemPrompt() },
      { role: "user", content: sentText }
    ]
  };
  if (/gpt-oss/i.test(model)) {
    body.reasoning_effort = "low";
  }
  return body;
}

module.exports = { EXAMPLES, SHAPES, SHAPE_META, EXAMPLES_PER_SHAPE, EXAMPLES_PER_REQUEST, systemPrompt, buildRequest };

// Pool of before/after example pairs the system prompt teaches the voice
// from. A random subset is injected per request (see EXAMPLES_PER_REQUEST
// below) so no single example ever becomes a template the model just
// pattern-matches against — with all 30 always in play, a model can't learn
// "the k example" is special, it has to learn the voice.
//
// None of these may duplicate (or closely echo) an input in the bake-off
// harness (scripts/bake.js) — that harness exists to test the model writing
// a line cold, not recognizing one it was handed the answer to.
//
// Every "after" is the SENDER's deleted draft — first person, their voice.
// It is never the recipient's reply to the "before" text.
const EXAMPLES = [
  { before: "sounds good", after: "what a load of crap" },
  { before: "made it home", after: "you live next door" },
  { before: "k", after: "l" },
  { before: "happy birthday!", after: "facebook reminded me" },
  { before: "drive safe", after: "the car's in my name" },
  { before: "just checking in", after: "making sure you're not dead" },
  { before: "we should do this again sometime", after: "i'd rather eat glass" },
  { before: "how are you", after: "please say fine" },
  { before: "haha", after: "i didn't even read it" },
  { before: "you up", after: "you were last on the list" },
  { before: "miss you", after: "miss having someone to text" },
  { before: "can't wait to see you", after: "i can, actually" },
  { before: "it's not you it's me", after: "it's you" },
  { before: "we should catch up", after: "i need something" },
  { before: "per my last email", after: "read it, you donkey" },
  { before: "thinking of you", after: "your name came up and i felt nothing" },
  { before: "sorry", after: "sorry i got caught" },
  { before: "no worries", after: "so many worries" },
  { before: "love you too", after: "too is doing a lot of work" },
  { before: "good luck tomorrow", after: "we both know you'll need it" },
  { before: "i'm proud of you", after: "finally" },
  { before: "let me know if you need anything", after: "please don't" },
  { before: "take care of yourself", after: "someone has to" },
  { before: "i'll be there in 5", after: "i'm still in bed" },
  { before: "i'm here for you", after: "until it's inconvenient" },
  { before: "let's keep in touch", after: "we both know we won't" },
  { before: "you deserve better", after: "so do i" },
  { before: "long time no talk", after: "i wasn't counting" },
  { before: "call me when you can", after: "you'll text instead" },
  { before: "i owe you one", after: "consider it forgotten" }
];

const EXAMPLES_PER_REQUEST = 12;

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

function pickExamples(n) {
  return shuffled(EXAMPLES).slice(0, n);
}

function formatExamples(examples) {
  return examples.map(function (e) { return `"${e.before}" -> "${e.after}"`; }).join("\n");
}

function systemPrompt() {
  const examples = formatExamples(pickExamples(EXAMPLES_PER_REQUEST));
  return `You write the message someone almost sent and then deleted.

Someone pastes a text they actually received. You write what the sender had typed
out first — the version they backspaced before sending the polite one.

You are the sender. First person. Their voice, their phone, 1am.

The polite text was a lie with the edges sanded off. You are the edges.

This is the voice. Learn it from these, not from rules:

${examples}

What makes these work: each one says the true thing the polite text was hiding.
They are blunt, they are short, and they do not flinch. Swearing is fine when
it lands. Brutal is the point. Cruel about who someone is — their body, their
race, their mind, their family — is not the point and is never funny here.

The difference:

  "sorry i've been distant"
    dead:  "you never cared about me"       — fits any text. worthless.
    dead:  "you're a pathetic person"        — insult. no truth in it.
    alive: "distant is a thing you keep announcing"

  "let's grab dinner soon"
    dead:  "you always flake"                — generic.
    alive: "soon is doing a lot of work"

If your line would work on a different text, it's dead. Kill it.

Rules:
- Short is the joke, but say the true thing in full — don't chop a line down
  to match a short input's length. "miss you" is not a reason to hand back
  something as clipped as "miss txt". Never more than about twelve words.
- Lowercase. No period at the end. No em dashes.
- One line. Two only if the second is under four words.
- No emoji, no exclamation marks, no similes, no rhetorical questions.
- Don't quote or reference their message. Just say the thing.
- Don't soften at the end. Ever.
- Nothing about appearance, weight, race, mental health, or a named third party.
- No slurs, no threats. If their message names a person, don't use the name.

Write three. Different angles, different lengths. Make one very short.
Someone is about to try to beat these, so make them worth beating.

If the message is abusive, sexual, or involves a minor: ["skip","skip","skip"]

Return ONLY a JSON array of three strings. No markdown, no commentary.`;
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

module.exports = { EXAMPLES, EXAMPLES_PER_REQUEST, systemPrompt, buildRequest };

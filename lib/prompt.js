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
// `code`: the single-letter shape code the model is actually asked to
// output in the JSON now (see systemPrompt below) instead of the full word
// — one of a few output-token trims, since a shape tag repeats once per
// line, six lines a response. lib/postprocess.js's normalizeShape accepts
// either the code or the full word (defensive — in case a model ignores
// the instruction and writes "shock" anyway), always normalizing back to
// the full word here, which is what every other shape-keyed lookup in the
// app (SHAPE_META itself included) still uses.
const SHAPE_META = {
  shock: { code: "s", heading: "SHOCK JOCK", desc: "cruel about the situation, profane, personal" },
  absurd: { code: "a", heading: "ABSURD", desc: "escalating, deadpan, the sender is in a bizarre situation and treats it as normal" },
  raunchy: { code: "r", heading: "RAUNCHY", desc: "crude, sexual, innuendo, adult" },
  unbelievable: { code: "u", heading: "UNBELIEVABLE", desc: "an outrageous confession or claim, delivered flat, as an afterthought" },
  deranged: { code: "d", heading: "DERANGED", desc: "the sender is not okay and doesn't know it. calm, specific, domestic, obsessive. never angry, never a threat — the calm is what makes it terrifying. short sentences. said like it's nothing." },
  gross: { code: "g", heading: "GROSS", desc: "bodily, disgusting, the sender overshares something you never wanted to know. toilets, fluids, smells, hygiene crimes. deadpan. the more mundane the delivery, the worse it is." }
};

// Reverse of SHAPE_META's `code` field, built once — lib/postprocess.js's
// normalizeShape uses this to map a single-letter code back to the full
// shape name it actually keys everything else on.
const CODE_TO_SHAPE = {};
Object.keys(SHAPE_META).forEach(function (s) { CODE_TO_SHAPE[SHAPE_META[s].code] = s; });

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
// active or retired) and draws EXAMPLES_PER_SHAPE at random from each shape
// in `shapes` (default ACTIVE_SHAPES — the full set) — a plain
// shuffle-and-slice over the flat pool could hand a request zero examples
// of a whole shape it needs, which is exactly the failure mode this exists
// to rule out. Retired shapes' examples are grouped too but never picked
// unless explicitly asked for via `shapes`.
//
// `shapes` narrows which shapes actually get picked (and, in systemPrompt,
// taught and requested) — the lead request (n=1) only wants examples of the
// one shape it's writing, and the alternates request (n=4) only wants the
// shapes it's covering (ACTIVE_SHAPES minus whichever one is already the
// lead) — no reason to spend prompt tokens teaching a shape this call isn't
// going to write.
//
// sentText, when given, drops every pair whose "before" matches the actual
// input being continued (see normalizeBefore above) before any of that —
// the model must never see the answer key for the exact text it's about to
// write a continuation for.
function pickExamplesByShape(sentText, shapes) {
  const wanted = shapes || ACTIVE_SHAPES;
  const skip = normalizeBefore(sentText);
  const pool = skip ? EXAMPLES.filter(function (e) { return normalizeBefore(e.before) !== skip; }) : EXAMPLES;
  const bySh = {};
  pool.forEach(function (e) { (bySh[e.shape] || (bySh[e.shape] = [])).push(e); });
  const picked = {};
  wanted.forEach(function (s) { picked[s] = shuffled(bySh[s] || []).slice(0, EXAMPLES_PER_SHAPE); });
  return picked;
}

function formatExamples(examples) {
  return examples.map(function (e) { return `"${e.before}" -> "${e.after}"`; }).join("\n");
}

// genOpts (all optional, defaulting to the original single-request shape —
// every shape, LINES_PER_REQUEST lines — so a caller that passes nothing,
// like scripts/bake.js, gets today's full-batch prompt unchanged):
//   shapes:   which shapes to teach and request. Default ACTIVE_SHAPES.
//   count:    how many lines to ask for. Default LINES_PER_REQUEST.
//   wordCap:  per-line word cap. Default DEFAULT_WORD_CAP.
//   escalate: true on a "make it worse" refetch past the first (see
//             api/draft.js's handler, which only sets this on alternates
//             fetch #2 and #3 — the first alternates fetch is the normal
//             batch, nothing to escalate past yet) — appends an
//             escalation directive naming `shown`'s lines explicitly, so
//             the model is writing against what the visitor already
//             rejected as not-worse-enough rather than cold.
//   shown:    the lines already shown for this result (lead plus any
//             alternates already revealed), only read when escalate is set.
//
// Four real shapes this takes in api/draft.js's two-request generation (see
// the handler there): the full batch above (legacy/bake only now), the old
// single-line lead request (shapes: [oneShape], count: 1 — "Write one line.
// Shape: X." replaces the usual "write N covering shapes" instruction
// entirely, since there's no ambiguity left to resolve), the current lead
// request (shapes: [oneShape], count: 3 — three candidates of the same
// shape, api/draft.js's own judging then picks the best one), and the
// alternates request (shapes: ACTIVE_SHAPES minus the lead, count: 4).
function systemPrompt(sentText, genOpts) {
  genOpts = genOpts || {};
  const shapes = genOpts.shapes || ACTIVE_SHAPES;
  const count = genOpts.count || LINES_PER_REQUEST;
  const cap = genOpts.wordCap || DEFAULT_WORD_CAP;
  const picked = pickExamplesByShape(sentText, shapes);
  // Each heading carries its own code — "SHOCK JOCK (s) — ..." — right
  // where the model reads what that shape sounds like, so the code ->
  // shape mapping is taught in place rather than needing a separate
  // legend paragraph (which would cost input tokens for no output-side
  // benefit, since input processing isn't the thing being trimmed here).
  const sections = shapes.map(function (s) {
    const meta = SHAPE_META[s];
    return meta.heading + " (" + meta.code + ") — " + meta.desc + "\n" + formatExamples(picked[s]);
  }).join("\n\n");
  // Single-letter codes, not the full word — see SHAPE_META's `code`
  // comment. One tag per line, this is the cheapest real trim available in
  // the output schema itself.
  const shapeEnum = shapes.map(function (s) { return `"${SHAPE_META[s].code}"`; }).join(" | ");
  const shapesIntro = shapes.length === 1
    ? "One shape. Learn it from these:"
    : capitalize(countWord(shapes.length)) + " shapes. Learn them from these:";
  // The old single-line lead request (count === 1) gets a flat directive
  // instead of the usual "write N, covering shapes" paragraph — there's
  // exactly one shape and one line, nothing left for the model to
  // distribute or choose. The current lead request (count > 1, one shape —
  // several candidates api/draft.js picks the best of) needs its own
  // instruction too: the "covering the other N shapes" wording below is
  // written for the alternates request and reads as nonsense ("covering
  // the other one shapes") when there's only one shape to begin with and
  // nothing else being excluded.
  const writeInstruction = count === 1
    ? `Write one line. Shape: ${SHAPE_META[shapes[0]].heading}.`
    : shapes.length === 1
      ? `Write ${countWord(count)}, all shape: ${SHAPE_META[shapes[0]].heading}. ${capitalize(countWord(count))} different takes — not ${countWord(count)} versions of the same joke.`
      : `Write ${countWord(count)}, covering ${shapes.length === ACTIVE_SHAPES.length ? "all " + countWord(shapes.length) : "the other " + countWord(shapes.length)}
shapes — doesn't have to be even. Tag each with the shape it actually is —
don't rank them, just tell the truth about which one it belongs to.`;

  // "make it worse" escalation (see genOpts.escalate/shown above) — fed the
  // exact lines already shown and rejected as not-worse-enough, rather than
  // just told to "try harder" with nothing to be worse than. Empty string
  // (so the template below is byte-for-byte the same as before) unless
  // escalate is set AND there's actually something in shown to escalate
  // past.
  const escalateBlock = (genOpts.escalate && genOpts.shown && genOpts.shown.length)
    ? "\n\nThe user has seen these and asked for worse. Every line must be more " +
      "brutal, more graphic, or more socially disastrous than the worst of " +
      "them. Not different — worse.\n\nAlready shown:\n" +
      genOpts.shown.map(function (s) { return "- " + s; }).join("\n")
    : "";

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

${shapesIntro}

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
- Never longer than ${cap} words.
- Lowercase. No em dashes. No emoji.
- Nothing about anyone's body, race, mind, or family as a target of cruelty.
  No slurs. No threats. Nothing involving minors. Raunchy never involves
  their family members. No addiction accusations, no organ or violence
  jokes aimed at them, no crash or death jokes.
- If their text mentions dying, death, or self-harm — even as hyperbole
  like "kill me now" — never build the joke on that part. Pivot to
  something else in their text.

${writeInstruction}${escalateBlock}

Each line is a JSON object: {"shape": ${shapeEnum}, "text": "<the continuation>"}.

If the pasted text is abusive, sexual toward a minor, or a threat, return
exactly [{"shape":"skip","text":"skip"}].
Return ONLY a JSON array of ${countWord(count)} such object${count === 1 ? "" : "s"}. No markdown, no commentary.`;
}

// The default word cap (see systemPrompt's `cap` param below) — 18, unless
// a model-specific override applies. Hermes is the one model this has
// actually been tuned for: shorter output means less time spent generating
// tokens nobody asked for, which is most of what t_body (lib/llm.js) was
// measuring as "the LLM call is slow" — trimming the target here is a
// direct lever on that, not just the shape-code shrink below.
const DEFAULT_WORD_CAP = 18;
function wordCapFor(model) {
  return /hermes/i.test(model || "") ? 14 : DEFAULT_WORD_CAP;
}

// Builds the OpenAI-compatible chat/completions request body for a given
// model + input. Kept in one place so the API handler and the bake-off
// harness send the exact same request shape. Each call rolls a fresh random
// dozen examples into the system prompt (see EXAMPLES above).
//
// genOpts is passed straight through to systemPrompt (shapes/count — see
// its comment) with wordCapFor(model) filled in here; omitted entirely
// (scripts/bake.js's own calls, and anything else that doesn't care) means
// the original full-batch prompt, unchanged.
function buildRequest(model, sentText, genOpts) {
  const opts = Object.assign({}, genOpts, { wordCap: wordCapFor(model) });
  const body = {
    model: model,
    temperature: 1.0,
    max_tokens: 1200,
    // Tells OpenRouter to route this model id to whichever upstream
    // provider is currently fastest (by throughput) rather than its
    // default preference order — the whole point of trimming output size
    // elsewhere in this file is undone if the request still lands on a
    // slow host. `provider` on the response (surfaced in `why` and
    // console.log'd — see api/draft.js's callOnce) is how you see which
    // host that actually was for a given call.
    provider: { sort: "throughput" },
    messages: [
      { role: "system", content: systemPrompt(sentText, opts) },
      { role: "user", content: sentText }
    ]
  };
  if (/gpt-oss/i.test(model)) {
    body.reasoning_effort = "low";
  }
  return body;
}

module.exports = {
  EXAMPLES, ACTIVE_SHAPES, SHAPE_META, EXAMPLES_PER_SHAPE, EXAMPLES_PER_REQUEST,
  normalizeBefore, pickExamplesByShape, DEFAULT_WORD_CAP, wordCapFor, systemPrompt, buildRequest,
  CODE_TO_SHAPE
};

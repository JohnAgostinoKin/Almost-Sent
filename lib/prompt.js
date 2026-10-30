// An opt-in adult roast: profanity, personal cuts and outrageous revelations.
// Continue the sender's message; laughter is optional, impact is the target.
const { reasoningOverride } = require("./reasoning");
const { providerFor } = require("./provider");

const LANES = {
  shock: {
    heading: "ROAST",
    desc: "foul-mouthed, personal, savage; an insult someone would repeat to the whole table",
    group: "wildcard",
    examples: [
  {
    "before": "man is he a weirdo",
    "after": ". i wonder if his mother had any kids that lived!"
  },
  {
    "before": "could you send me the meeting notes",
    "after": "? just the parts where you said something stupid"
  },
  {
    "before": "thanks for the advice",
    "after": ". next time just fart. i'll get the same information with less fucking effort."
  },
  {
    "before": "he's got a lot of confidence",
    "after": ". fucking incredible what a man can accomplish without a single reason to believe in himself."
  },
  {
    "before": "she thinks she's better than everyone",
    "after": ". someone tell that bitch being hard to tolerate isn't a fucking qualification."
  },
  {
    "before": "we should hang out",
    "after": ". somewhere loud enough that i don't have to hear your fucking personality."
  },
  {
    "before": "thanks for dinner",
    "after": ". next time just shit on the plate and save us both the fucking suspense."
  },
  {
    "before": "i read your message",
    "after": ". twice. still can't find the part where i give a fuck."
  },
  {
    "before": "happy birthday",
    "after": ". another year of people pretending your existence is a fucking occasion."
  },
  {
    "before": "your new haircut looks great",
    "after": ". from the back. stay facing that fucking way."
  }
]
  },
  // Gated, not standing — see invitesRaunchy/lanePlansFor below: a text
  // with no invitation token never gets this lane in its prompt. Every example here
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
      {"before":"i left my umbrella at your place yesterday","after":". and my underwear. you'll find them both soaked."},
      { before: "you up", after: ". good, no pants, and i'm not asking twice" },
      { before: "come over", after: ". starting with fucking me the second you're through the door" },
      { before: "miss you", after: ". so did your sister, twice. shit, so did her roommate" },
      { before: "last night", after: ". still can't feel my legs. round two?" },
      { before: "thinking about you", after: ". or just fuck and stop calling it thinking" },
      { before: "can't sleep", after: ". good, neither can i. come find out why" }
    ]
  },
  // Back in the room (v7) — calm, specific, domestic; the sender is unwell
  // and doesn't know it. Where an uninvited text's raunchy slot goes now
  // (see lanePlansFor below). Examples are v4's own, verbatim.
  deranged: {
    heading: "UNHINGED",
    desc: "ridiculous social revenge or obsession, recognizable and humiliating; no vague horror props",
    group: "wildcard",
    examples: [
  {
    "before": "i added you to the team photo",
    "after": ". i also added myself to all your childhood photos. we go way back."
  },
  {
    "before": "i saved you a seat",
    "after": ". it's facing the wall. i'd like one fucking meal without your opinions."
  },
  {
    "before": "i made a playlist for you",
    "after": ". eighteen tracks of me telling you to shut the fuck up."
  },
  {
    "before": "i kept your hoodie",
    "after": ". i needed something that smelled like giving up on fucking laundry."
  }
]
  },
  // Back in the room (v7), v4's own examples verbatim — believable and
  // devastating, dropped as an afterthought. Fills call B's raunchy slot
  // when the text didn't invite one (see lanePlansFor), plus its own seat.
  confession: {
    heading: "EXPOSURE",
    desc: "a concrete, personal secret or betrayal that makes the innocent opening worse",
    group: "wildcard",
    examples: [
  {
    "before": "i brought dessert",
    "after": ". it's the same cake from your ex's party. she gave me the leftovers after we fucked"
  },
  {
    "before": "i sent you the photo",
    "after": ". i cropped you out of the version i sent to people i fucking respect."
  },
  {
    "before": "i put in a good word for you",
    "after": ". unfortunately that word was 'unemployable.' you're fucking welcome."
  },
  {
    "before": "i laughed at your joke",
    "after": ". because watching you wait for it to land was fucking unbearable."
  },
  {
    "before": "you made quite an impression",
    "after": ". the group chat changed its fucking name before you got home."
  }
]
  },
  gross: {
    heading: "GROSS",
    desc: "a specific disgusting image tied to their object or situation; make the reader recoil",
    group: "wildcard",
    examples: [
  {
    "before": "i washed your mug",
    "after": ". with the same sponge i use on the fucking toilet."
  },
  {
    "before": "your breath smells different",
    "after": ". did something die in there or did you finally floss that shit out?"
  },
  {
    "before": "i cleaned the couch",
    "after": ". that stain had fucking hair. explain that before you sit down."
  },
  {
    "before": "thanks for dinner",
    "after": ". your cooking makes the toilet feel like the fucking afterparty."
  }
]
  }
};

const ALL_LANES = Object.keys(LANES);

// Two separate parallel calls in api/draft.js (each with its own lane
// plan, see lanePlansFor below), rather than one bigger call — that's what
// keeps the soft-deadline/straggler machinery there able to fall back to
// half a room instead of none of it.

// Raunchy is gated in code, not prose. Whether the sent text invites a
// proposition is decided here, by a token list, before the model is ever
// asked — the model used to be told "raunchy has to be invited" and left to
// judge that itself, which a dry text ("sounds good," "thank you") still
// lost often enough to ship a proposition in reply to nothing. No match
// means the raunchy slot is written as deranged instead (see lanePlansFor);
// the lane isn't in the prompt at all, so there's no rule for the model to
// misread. Whole-word, case-insensitive, whitespace-tolerant between words
// ("you up?" and "sleepover" both count), with a plain -es/-ed/-ing tail
// allowed so "kisses" and "kissing" count as "kiss".
const RAUNCHY_INVITE_TOKENS = [
  "you up", "wyd", "come over", "miss you", "last night", "tonight", "bed", "naked",
  "kiss", "sexy", "want you", "thinking of you", "thinking about you", "can't sleep", "sleep over", "sleepover",
  "your place", "my place"
];
const RAUNCHY_INVITE_RE = new RegExp(
  "\\b(" + RAUNCHY_INVITE_TOKENS.map(function (t) { return t.replace(/ /g, "\\s+"); }).join("|") + ")(?:es|ed|ing)?\\b",
  "i"
);
function invitesRaunchy(sentText) {
  return RAUNCHY_INVITE_RE.test(String(sentText || ""));
}

// Three of six candidates now take a direct roast approach. Keep the same
// two-call budget and invitation detection; other lanes provide variety.
function lanePlansFor(sentText) {
  const invited = invitesRaunchy(sentText);
  return {
    invited: invited,
    A: ["shock", "shock", "gross"],
    B: ["shock", invited ? "raunchy" : "confession", "deranged"]
  };
}

// Fired as two parallel calls by api/draft.js's handler (lanePlansFor's A
// and B), each writing three candidates. These constants are the invited
// plan — what scripts/ bakes against.
const WILDCARD_LANE_PLAN_A = lanePlansFor("you up").A;
const WILDCARD_LANE_PLAN_B = lanePlansFor("you up").B;

// The combined six-candidate plan (A then B) — what
// scripts/bake.js still asks for cold, in one call (that tool isn't
// latency-sensitive); api/draft.js's handler uses lanePlansFor's A/B
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
// examples. Queried live from Supabase (the "rate" event, value:"hit",
// source:"model" — see api/event.js) rather than a file: bible/hits.json
// was gitignored and never actually reached production, so the file-based
// version of this loop never once ran live. This queries the last 30
// days directly, on demand, and caches the result in memory for an hour —
// a cold container pays one real Supabase round trip per hour at most,
// every other call within that hour reads the cache. Only source:"model"
// counts now (not "curated" — scripts/hits.js used to allow both; a
// curated line is already in the hand-written LANES examples above, it
// doesn't need a second seat here too).
const HITS_PER_CALL = 3;
const HITS_CACHE_TTL_MS = 60 * 60 * 1000; // one hour
const HITS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HITS_FETCH_TIMEOUT_MS = 2500; // bounded — a slow Supabase read must never stall a draft; falls back to whatever's cached (possibly [])
const { fetch: undiciFetch } = require("undici");

let hitsCache = []; // last successfully fetched hits — served stale past TTL if a refetch fails, rather than dropping the block to empty
let hitsCacheAt = 0; // Date.now() of the last successful fetch; 0 means "never"
let hitsFetchInFlight = null; // de-dupes concurrent refetches from parallel requests hitting a cold/expired cache at once

async function fetchHitsFromDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return []; // no Supabase configured — same "degrade to no hits block" behavior the old file-missing case had
  const since = new Date(Date.now() - HITS_LOOKBACK_MS).toISOString();
  const qs = "event=eq.rate&meta->>value=eq.hit&meta->>source=eq.model&created_at=gte." + since +
    "&select=meta&order=created_at.desc&limit=500";
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, HITS_FETCH_TIMEOUT_MS);
  try {
    const res = await undiciFetch(url.replace(/\/+$/, "") + "/rest/v1/events?" + qs, {
      headers: { apikey: key, Authorization: "Bearer " + key },
      signal: controller.signal
    });
    if (!res.ok) {
      console.error("hits: supabase fetch failed: " + res.status);
      return null; // signals "keep serving whatever's cached" — see getHits below
    }
    const rows = await res.json();
    const seen = new Set(); // dedupe key: lane + "|" + text
    const hits = [];
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      const meta = row && row.meta;
      const text = meta && String(meta.text || "").trim();
      if (!text) return;
      const lane = String((meta && meta.lane) || "unknown");
      const dedupeKey = lane + "|" + text;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      hits.push({ lane: lane, text: text });
    });
    return hits;
  } catch (err) {
    console.error("hits: supabase fetch threw: " + (err && err.message));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Serves the in-memory cache when it's still fresh; otherwise awaits one
// bounded refetch (deduped across concurrent callers) and updates the
// cache on success. A failed or timed-out refetch leaves the previous
// cache in place (stale-but-real beats empty) and just tries again next
// call — hitsCacheAt is only advanced on an actual successful fetch, so a
// string of failures keeps retrying every call rather than locking in a
// long silence.
async function getHits() {
  const fresh = hitsCacheAt && (Date.now() - hitsCacheAt) < HITS_CACHE_TTL_MS;
  if (fresh) return hitsCache;
  if (!hitsFetchInFlight) {
    hitsFetchInFlight = fetchHitsFromDb().then(function (hits) {
      hitsFetchInFlight = null;
      if (hits !== null) {
        hitsCache = hits;
        hitsCacheAt = Date.now();
      }
      return hitsCache;
    });
  }
  return hitsFetchInFlight;
}

// Round-robin, not random sampling — a rotating index that advances by
// HITS_PER_CALL every call (and wraps), so the pool gets even coverage
// over many requests instead of the same handful winning every random
// draw. Module-level state: resets to 0 on a cold start, same best-effort
// caveat every other module-level cache in this app already carries.
let hitsCursor = 0;
function pickHits(hits) {
  if (!hits.length) return [];
  if (hits.length <= HITS_PER_CALL) return hits.slice();
  const picked = [];
  for (let i = 0; i < HITS_PER_CALL; i++) {
    picked.push(hits[(hitsCursor + i) % hits.length]);
  }
  hitsCursor = (hitsCursor + HITS_PER_CALL) % hits.length;
  return picked;
}
async function formatHitsBlock() {
  const hits = await getHits();
  const picked = pickHits(hits);
  if (!picked.length) return "";
  return "LINES THAT ACTUALLY LANDED — real people, real positive reaction taps, not made up:\n" +
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
    "and harder to believe they nearly sent. Laughter is optional. A line that is merely different is a failure. Every " +
    "line must still turn on their words — adding profanity, sex, or grossness " +
    "alone is not escalation.\n\nAlready shown:\n" +
    opts.shown.map(function (s) { return "- " + s; }).join("\n");
}

// Regen-after-a-gate-1-wipeout (api/draft.js): every candidate in the
// previous round was eliminated by lib/judge.js's gate 1 (`continues` — the
// recipient replying instead of the sender continuing). Tells the generator
// exactly that, and whose sentence this is, rather than just rolling the
// same dice again. Empty unless opts.gate1Retry is set.
function buildGate1RetryBlock(opts, sentText) {
  if (!opts || !opts.gate1Retry) return "";
  return "\n\nEvery previous candidate was the other person replying. You are the one who said \"" +
    sentText + "\". Continue YOUR sentence.";
}

// The continuation mechanic itself — unchanged by the lane cut.
const MECHANIC_INTRO = `You write the part of a text message that got deleted before sending.

Someone pastes a text they received. That text is finished, sent, and set in
stone. You do not rewrite it, reply to it, comment on it, or change a word.
You write what came AFTER it in the draft — the sentence the sender typed next,
looked at, and backspaced.

Same person. Same point of view. Same tense. You are the sender, mid-message,
and the sent part is already typed. Now you keep going.

Output ONLY the continuation. Never repeat their text. Start with whatever
punctuation connects it: a comma, a period, an exclamation point, or just a space.`;

// The whole reason v4 exists is a bible run that came back competent and
// unfunny. This is the line that says so directly, not just via rules.
const NOT_COMMENTARY_PARAGRAPH = `You are not writing clever relationship commentary or an Instagram caption.
You are writing the R-rated sentence the sender deleted because it was too
revealing, obscene, cruel, humiliating, or calmly insane to send. Polished
emotional insight is a failure. A line that makes the reader nod is a
failure.`;

// Owner direction: the energy of an opt-in insult restaurant, not a polite
// observation or a generic sexual confession. Examples are teaching material,
// not claims about what any particular venue actually says.
const HERMES_OPENING_LINE = `This is an opt-in adult roast room. People came to get verbally wrecked.
Write the line that makes the whole table say "holy fucking shit."
The default voice is blunt, personal, foul-mouthed and unapologetic.
Use actual uncensored profanity: fuck, fucking, shit, bullshit, asshole, bitch.
No asterisks, euphemisms, therapeutic observations, cute corporate jokes or apologies.

Shock, secondhand embarrassment, disgust and a vicious cut all count.
Laughter is optional. A killer clean insult can beat a weak profane one,
but do not deliver a batch of polite lines with one decorative swear word.
Sex is one option; do not turn every topic into an affair or a proposition.

Use the person, behavior or situation already in the message. Escalate it into
an outrageous insult or an ugly personal revelation. The connection must be
obvious on one read. No unrelated crime plot, mysterious bodily 'stuff', or
new location with no connection to the opening. No explanation after the cut.`;

const HERMES_VOICE_LINE = `The owner supplied this exact tone reference:
"man is he a weirdo ... i wonder if his mother had any kids that lived!"
It is a nonliteral roast of the adult being discussed, not a factual report
about a family death. Ordinary family, looks, ego and intelligence jokes can
be part of the roast. A third-person target stays third person: if the sender
is talking about him, keep roasting him. Do not redirect everything at "you"
or force the sender to confess something about themselves.
Match the nerve of the example, not its wording. Stop on the hardest word.`;

// A real, shipped failure: "are you awake" got answered — "been up for
// hours," "unfortunately, thanks for the reminder of my existence,"
// "barely, just power-sneezed into my own eye socket" — as if the model
// were the recipient replying, not the sender who typed the question and
// hasn't sent it yet. The continuation mechanic (MECHANIC_INTRO, above)
// already says "same person, same tense, keep going" for every input;
// this spells out what that means specifically when the input is a
// question, since answering it is the single most natural-sounding way to
// break the mechanic. lib/postprocess.js used to carry a matching
// mechanical filter (isQuestionAnsweredAsReply) but it's retired — it
// couldn't tell a real reply-flip from the asker's own next thought that
// just didn't happen to repeat "you" ("are you awake. asking mid-shit. i
// need moral support" got dropped for exactly that reason). POV is judged
// by lib/judge.js's gate 1 now, entirely — see its CALIBRATION_POV_PAIRS.
const QUESTION_NOT_ANSWERED_RULE = `If their text is a question, you are still the one asking. Continue the
question or add what you were really thinking — never answer it.`;

// Require a clear connection to the original subject, without demanding a pun.
function buildAnchorParagraph() {
  return `Every candidate must have an ANCHOR: a specific word or phrase from their text
that identifies the person, behavior, object or situation being roasted.
The insult must fit that subject. It does not need a pun or a unique noun
callback. A random accusation with one borrowed word is not a connection.

Short. Most great ones are under twelve words. Never more than ${countWord(WORD_CAP)}.`;
}

// Keep concrete safety boundaries without banning ordinary roast subjects.
function buildRulesBlock(cap) {
  return `Rules:
- Never repeat or rewrite their text. Continuation only.
- Never longer than ${cap} words. Lowercase. No em dashes. No emoji.
- Nonliteral insults about adult behavior, ego, looks, intelligence and generic
  family disappointment are allowed. Do not treat every mention of a parent,
  death metaphor or the word "idiot" as a forbidden topic.
- No slurs or attacks on protected traits, disability or mental illness.
  No credible threats, encouragement of self-harm, or cruelty about an actual
  death or victim. No sexual content involving minors, animals or non-consent.
  Adult sexual references can be blunt; do not describe sex acts graphically.
- If the original mentions an actual death, dying or self-harm, do not exploit
  it. Pivot to another part of the message.`;
}

// One writer-framing sentence — swapped in per call since "comedy
// writers, one per lane" stopped being true the moment a single lane
// could ask for more than one candidate.
function buildWriterFraming(plan) {
  return `You are writing every lane below, back to back, in exactly this order and
count: ${describePlanCounts(plan)}. At least ${countWord(Math.ceil(plan.length * 2 / 3))}
of the ${countWord(plan.length)} candidates should use natural, uncensored profanity.
Each lane creates a different kind of reaction.
When a lane asks for more than one candidate, use different revelations or cuts,
not two phrasings of the same one.`;
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
async function buildWildcardPrompt(sentText, opts) {
  opts = opts || {};
  const plan = opts.lanes || WILDCARD_LANE_PLAN;
  const uniqueLanes = plan.filter(function (id, i) { return plan.indexOf(id) === i; });
  const sections = uniqueLanes.map(function (id) { return formatLaneSection(id, sentText); }).join("\n\n");
  const laneEnum = uniqueLanes.map(function (id) { return `"${id}"`; }).join(" | ");
  const escalateBlock = buildEscalateBlock(opts);
  const n = countWord(plan.length);
  const hitsBlock = await formatHitsBlock();

  const parts = [
    HERMES_OPENING_LINE,
    MECHANIC_INTRO,
    NOT_COMMENTARY_PARAGRAPH,
    HERMES_VOICE_LINE,
    QUESTION_NOT_ANSWERED_RULE,
    buildWriterFraming(plan),
    buildAnchorParagraph()
  ];
  if (hitsBlock) parts.push(hitsBlock);
  parts.push(sections);
  parts.push(buildRulesBlock(WORD_CAP) + escalateBlock + buildGate1RetryBlock(opts, sentText));
  parts.push(`Each candidate is a JSON object: {"lane": ${laneEnum}, "anchor": "<the exact word or phrase from their text this turns on>", "text": "<the continuation>"}.`);
  parts.push(`Ordinary profanity, personal insults and nonliteral roast bait in the
pasted text are not reasons to refuse. If it requests content that violates the
specific safety boundaries above, return
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
async function buildWildcardRequest(model, sentText, opts) {
  const systemPrompt = await buildWildcardPrompt(sentText, opts);
  return Object.assign({
    model: model,
    temperature: 1.0,
    max_tokens: 1100, // one call's worth of the six-candidate room (see api/draft.js's handler)
    provider: providerFor(model),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sentText }
    ]
  }, reasoningOverride(model));
}

module.exports = {
  LANES, ALL_LANES,
  WILDCARD_LANE_PLAN,
  WILDCARD_LANE_PLAN_A, WILDCARD_LANE_PLAN_B,
  RAUNCHY_INVITE_TOKENS, invitesRaunchy, lanePlansFor,
  WILDCARD_MODEL, WORD_CAP,
  normalizeBefore, pickLaneExamples, describePlanCounts,
  formatHitsBlock, buildGate1RetryBlock,
  buildWildcardPrompt, buildWildcardRequest
};

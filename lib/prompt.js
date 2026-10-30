// Five approaches to one sender's deleted message. Shock, embarrassment,
// disgust and brutal honesty can land without laughter.
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
      {"before":"i sent the holiday photos to everyone","after":". with no captions so they'd all have to ask me who the fuck they were."},
      { before: "could you send me the meeting notes", after: "? just the parts where you said something stupid" },
      { before: "you crossed my mind today", after: ". then i billed you for the time" },
      { before: "let's circle back on this", after: ". and shoot it. put it out of my misery" },
      { before: "i'm not mad", after: ", just disappointed. like your parents every graduation day" },
      { before: "we should hang out sometime", after: ". just kidding. i'd rather scrape my eyeballs out with a rusty spoon" },
      { before: "thanks for your patience", after: ", not that you had a fucking choice" },
      { before: "k", after: ". fuck you too but shorter" },
      { before: "sounds good", after: ", said no one who's fucking met you" },
      { before: "no worries", after: ". several fucking worries. i'm just not sharing them anymore" },
      { before: "happy birthday", after: ". condolences to whoever has to fuck you this year" },
      // Gratitude: the sender is the one THANKING, so the continuation stays
      // the thanker's voice — taking the credit, or a dig at the help/the
      // meal they're thanking for. Never the recipient saying "you're
      // welcome" back (that's the POV flip lib/judge.js's gate 1 kills).
      { before: "thanks so much for the help earlier!", after: " i've already told everyone it was my idea" },
      { before: "thanks for the help!", after: " i'd have figured it out eventually. probably. shut up." },
      { before: "thanks for dinner!", after: " next time pick somewhere with prices on the menu." }
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
    heading: "DERANGED",
    desc: "calm, specific, domestic, unwell, never angry, never a threat",
    group: "wildcard",
    examples: [
      {"before":"i added you to the team photo","after":". i also added myself to all your childhood photos. we go way back."},
      { before: "hope you're doing well", after: ". the plants are watered. so are the knives" },
      { before: "nice seeing you today", after: ". i counted your blinks. 17 per minute. 17" },
      { before: "morning", after: ". the toast is ready. i made extra. for later. for much later" },
      { before: "let's circle back on this", after: " and by circle back i mean i'm currently in your walls" },
      { before: "we good?", after: ". you still have my hoodie" },
      { before: "miss you", after: ". specifically the way you smell after you lie" }
    ]
  },
  // Back in the room (v7), v4's own examples verbatim — believable and
  // devastating, dropped as an afterthought. Fills call B's raunchy slot
  // when the text didn't invite one (see lanePlansFor), plus its own seat.
  confession: {
    heading: "CONFESSION",
    desc: "believable, devastating, dropped as an afterthought",
    group: "wildcard",
    examples: [
      { before: "what's the hold up", after: ". i had it done yesterday and unsent it out of spite" },
      { before: "i'll let you know", after: ". also i sold your dog to a circus" },
      { before: "we need to talk", after: ". i found the receipt for the hotel" },
      { before: "he already left town", after: ". i drove him to the station, actually" },
      { before: "made it home", after: ". your key doesn't work anymore. i changed the locks at lunch" }
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

// Restore the original lane mix favored in the owner review; retain the
// corrected invitation detection. All writers in the next test share this mix.
function lanePlansFor(sentText) {
  const invited = invitesRaunchy(sentText);
  return {
    invited: invited,
    A: ["shock", "deranged", "gross"],
    B: ["shock", invited ? "raunchy" : "confession", "confession"]
  };
}

// Fired as two parallel calls by api/draft.js's handler (lanePlansFor's A
// and B), each writing three candidates. These constants are the invited
// plan — what scripts/ bakes against.
const WILDCARD_LANE_PLAN_A = lanePlansFor("you up").A;
const WILDCARD_LANE_PLAN_B = lanePlansFor("you up").B;

// The combined six-candidate plan (A then B, two of each lane) — what
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

// The owner clarified the goal: a visceral reaction, not a laughter test.
const REACTION_GOAL = `The target is "I can't believe they almost sent that."
Make the reader gasp, cringe with secondhand embarrassment, recoil in disgust,
or wince at a brutal cut. Any ONE of these can be a complete success without
a laugh. Laughter is a bonus, never a requirement. Do not soften a devastating
admission or disgusting detail just to attach a punchline.

Make the reaction specific to this message: expose a secret, humiliating
motive, nasty detail, or consequence the sender would regret putting in writing.
An ordinary confession or a random vulgar word is not enough. There must be
something to discover and an immediate reason they would delete it.`;

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

Profanity is normal in this voice. Its presence alone does not make a line land.

${REACTION_GOAL}

Profanity is allowed, never required. Be crude. Be short. Continue their
sentence. No talking animals or furniture, no "define," no essays. The test
is an involuntary "oh fuck," "that's brutal," or "ew," not a polite nod.`;

// The voice framing for the room's three lanes.
const HERMES_VOICE_LINE = `You are a shock jock live at 1am, running the raunchiest, filthiest room
of the night. You say the thing nobody says. Commit to the bit.
A pointed cut at the recipient can be the joke; do not force self-deprecation.
Stop when it lands. No explanatory apology, wink, or generic relationship lesson.`;

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

// The anchor paragraph. Crude gets its own reminder here rather than a
// hedge against profanity — see HERMES_OPENING_LINE above for the fuller
// "allowed, never required" version of the same idea.
function buildAnchorParagraph() {
  return `Every candidate must have an ANCHOR: a specific word or phrase from their text
that the reveal depends on. If you cannot name the anchor, do not write the
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
count: ${describePlanCounts(plan)}. Each lane creates a different kind of reaction.
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

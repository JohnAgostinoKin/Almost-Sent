// api/draft.js

const SYSTEM = `You write the message someone almost sent and then deleted.

Someone gives you a real text they received. You write what that person had typed
out thirty seconds earlier, before they backspaced it and sent the safe version.

You are the sender. First person. Their voice.

The joke is never the insult. The joke is the truth. A polite text is a lie with
the edges sanded off, and you put the edges back on.

Learn the voice from these. This is the whole job:

"sounds good" -> "what a load of crap"
"made it home" -> "you live next door"
"k" -> "l"
"omw" -> "i haven't left"
"you good" -> "i don't want the real answer"
"just checking in" -> "checking a box"
"we'll see" -> "we won't"
"here" -> "been here nine minutes"
"sorry" -> "i'm caught"
"do what you want" -> "do what i want"
"was thinking about you" -> "for about four seconds"
"missed you tonight" -> "noticed you weren't there"
"i'm not mad" -> "i'm mad"
"hello" -> "i want something"
"per my last email" -> "you did not read it"
"that was fun" -> "fun is generous"
"goodnight" -> "good"

Notice what those do. Each one attaches to a specific word or a specific lie in
the message. Each is as short as or shorter than what it answers. None insults
the person's looks, worth, or character. They are funny because they are true.

Now the failure mode, so you can avoid it:

"sorry i've been distant lately"
  weak: "you never really cared about me"      <- fits any message. worthless.
  weak: "you're a selfish person"              <- insult, not truth.
  good: "distant is a thing you keep announcing"

"we should grab dinner sometime"
  weak: "you always do this to me"             <- generic.
  good: "sometime is doing a lot of work here"

If your line would work just as well on a completely different text, throw it out
and write a sharper one.

RULES
Never longer than what they sent. Short is the joke.
Lowercase. No period at the end. No em dashes.
One line. Two only if the second is under four words.
No emoji, no exclamation marks, no similes, no rhetorical questions.
Do not quote or reference their message. Just say the thing.
Do not soften it at the end.
Nothing about appearance, weight, race, mental health, or a named third party.
No slurs, no threats. If their message names a person, do not use the name.

CATEGORY
ex — resentment under civility
almost — wanting, never admitted
friend — the small grudge never raised
boss — contempt under professionalism
family — bitter but never cold, the love survives it
other — puncture the lie in the politeness

Write three, each going somewhere different. Vary the length: make one of them
very short. Someone is about to try to beat these, so make them worth beating.

If the message is abusive, sexual, or involves a minor, return ["skip","skip","skip"]

Return ONLY a JSON array of three strings. No markdown, no commentary.`;

const BLOCK = [
  /\b(kill (him|her|them|myself|yourself)|suicide|rape|molest)\b/i,
  /\b(minor|underage|1[0-7][ -]?year[ -]?old)\b/i,
  /\b(find (their|his|her) address|track (their|his|her) phone|stalk)\b/i
];

// Curated bank. Every line exposes what the polite version was covering for.
// A line that is only an insult does not belong here.
const LINES = {
  "k": "l",
  "ok": "not ok",
  "okay": "not okay",
  "lol": "nobody laughed",
  "haha": "ha",
  "sounds good": "what a load of crap",
  "we'll see": "we won't",
  "keep me posted": "don't",
  "i'll let you know": "i won't",
  "maybe next week": "there is no next week",
  "just checking in": "checking a box",
  "you good": "i don't want the real answer",
  "made it home": "you live next door",
  "get home safe": "or don't",
  "goodnight": "good",
  "gn": "g",
  "morning": "unfortunately",
  "omw": "i haven't left",
  "here": "been here nine minutes",
  "nvm": "i minded",
  "never mind": "i minded",
  "ignore that": "don't",
  "it's fine": "it's not fine",
  "i'm not mad": "i'm mad",
  "no worries": "several worries",
  "all good": "some good",
  "my bad": "your bad",
  "whatever": "not whatever",
  "do what you want": "do what i want",
  "we good": "we're not",
  "forget it": "don't forget it",
  "we should talk": "i already decided",
  "can we talk": "i already decided",
  "call me": "i won't pick up",
  "we should do this again sometime": "sometime is doing a lot of work",
  "that was fun": "fun is generous",
  "missed you tonight": "noticed you weren't there",
  "was thinking about you": "for about four seconds",
  "you up": "i already know you are",
  "still up": "i've been watching the typing dots",
  "seen": "chose not to answer",
  "hello": "i want something",
  "are you free later": "i just don't want to be alone",
  "sorry": "i'm caught",
  "thanks": "that took you long enough",
  "per my last email": "you did not read it",
  "circling back": "third time",
  "?": "you know",
  "??": "you still know"
};

// Last resort only. These are general by nature, which is why they are last.
// If users are seeing these often, the model path is broken — check `source`.
const KEYS = [
  { re: /\bsorry\b/, line: "you're not sorry, you're caught" },
  { re: /\bbusy|working|at work\b/, line: "work is the costume" },
  { re: /\blater|tomorrow|next week|sometime\b/, line: "later is a polite never" },
  { re: /\blove you\b/, line: "now say it without the safety net" },
  { re: /\bmiss you\b/, line: "then stop performing distance" },
  { re: /\bdrunk|drinking|wine|beer\b/, line: "the alcohol typed this" },
  { re: /\btired|sleep|nap\b/, line: "exhaustion is the nicest exit" },
  { re: /\brain|weather|traffic\b/, line: "that is not why you cancelled" },
  { re: /\bmaybe\b/, line: "maybe is a no with manners" }
];

function bad(text) {
  return BLOCK.some(function (re) { return re.test(text); });
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") { try { return JSON.parse(body); } catch (e) { return {}; } }
  return body;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['\u2019]/g, "'")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function exact(sent) {
  const raw = String(sent || "").trim();
  if (raw === "?") return LINES["?"];
  if (raw === "??") return LINES["??"];
  return LINES[norm(raw)] || null;
}

function keyword(sent) {
  const hit = KEYS.find(function (row) { return row.re.test(String(sent).toLowerCase()); });
  return hit ? hit.line : null;
}

function dirty(line) {
  if (!line) return true;
  const t = String(line).trim();
  if (!t) return true;
  if (/developer|instruction|the user asks|json array|system prompt|as an ai/i.test(t)) return true;
  return false;
}

// Loosened from 1.2x to 1.6x with a 40-char floor. The tighter cap was throwing
// away usable lines and pushing requests into the generic fallback.
function tooLong(line, sent) {
  const ceiling = Math.max(sent.trim().length * 1.6, 40);
  return String(line).trim().length > ceiling;
}

function flattenText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (typeof value === "object") {
    return [value.content, value.text, value.reasoning].map(flattenText).join("\n");
  }
  return "";
}

function parseThree(raw, sent) {
  const text = flattenText(raw);
  const block = (text.match(/\[[\s\S]*\]/) || [])[0];
  if (!block) return { lines: [], why: text ? "no json in output" : "empty output" };

  let arr;
  try { arr = JSON.parse(block); } catch (e) { return { lines: [], why: "json truncated" }; }
  if (!Array.isArray(arr)) return { lines: [], why: "not an array" };

  const cleaned = arr.map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  const skips = cleaned.filter(function (s) { return s.toLowerCase() === "skip"; }).length;
  if (skips && skips >= cleaned.length / 2) return { lines: [], skip: true };

  const kept = cleaned.filter(function (s) {
    return s.toLowerCase() !== "skip" && !dirty(s) && !tooLong(s, sent);
  });

  return {
    lines: kept.slice(0, 3),
    why: kept.length ? null : "all " + cleaned.length + " filtered (length or content)"
  };
}

function category(who) {
  const w = String(who || "").toLowerCase();
  if (w === "mom" || w === "dad" || w === "family") return "family";
  if (["ex", "almost", "friend", "boss"].indexOf(w) !== -1) return w;
  return "other";
}

async function fromAi(sent, who, recent) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { lines: [], why: "no api key" };

  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const avoid = Array.isArray(recent) ? recent.slice(-12).join(" | ") : "";
  const user =
    "category: " + category(who) + "\n" +
    "they sent: \"" + sent + "\"\n" +
    (avoid ? "already used, do not repeat these shapes: " + avoid : "");

  const payload = {
    model: model,
    temperature: 1.0,
    // Room for reasoning tokens. At 400 the gpt-oss models were spending the
    // budget thinking and returning truncated JSON, which silently dropped every
    // request into the generic fallback.
    max_tokens: 1500,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user }
    ]
  };
  // gpt-oss reasons by default; keep it short so the budget goes to the answer.
  if (/gpt-oss/.test(model)) payload.reasoning_effort = "low";

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 12000);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (data && data.error) return { lines: [], why: "groq: " + (data.error.message || "error") };
    const choice = data && data.choices && data.choices[0];
    if (!choice) return { lines: [], why: "no choices returned" };
    const out = parseThree(choice.message, sent);
    if (!out.lines.length && choice.finish_reason === "length") out.why = "hit token limit";
    return out;
  } catch (err) {
    return { lines: [], why: err.name === "AbortError" ? "timed out" : "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Per-instance only. Stops casual hammering, not a determined one — a real limit
// needs shared state (Upstash or a Supabase table).
const HITS = new Map();
function limited(ip) {
  const now = Date.now();
  const row = HITS.get(ip) || { n: 0, start: now };
  if (now - row.start > 60000) { row.n = 0; row.start = now; }
  row.n += 1;
  HITS.set(ip, row);
  if (HITS.size > 5000) HITS.clear();
  return row.n > 20;
}

async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url + "/rest/v1/inbox", {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ key: norm(sent) || sent.trim(), sent: sent.trim().slice(0, 500) })
    });
  } catch (err) {}
}

const ORIGINS = ["https://almostsent.app", "https://www.almostsent.app", "http://localhost:3000"];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.indexOf(origin) !== -1) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) { res.status(429).json({ error: "slow down" }); return; }

  const body = readBody(req);
  const sent = String(body.sent || "").trim().slice(0, 500);
  const who = String(body.who || "").trim().slice(0, 40);
  const recent = Array.isArray(body.recent) ? body.recent : [];
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }
  if (bad(sent)) { res.status(200).json({ refuse: true, drafts: [] }); return; }

  const ai = await fromAi(sent, who, recent);
  if (ai.skip) { res.status(200).json({ refuse: true, drafts: [] }); return; }

  const drafts = [];
  const bank = exact(sent);
  if (bank) drafts.push(bank);
  ai.lines.forEach(function (line) {
    if (drafts.indexOf(line) === -1) drafts.push(line);
  });

  // `source` tells you which path produced what you are reading:
  //   model    — the model wrote it (what you want)
  //   bank     — a curated line matched exactly
  //   fallback — the model produced nothing usable, `why` says what went wrong
  let source = ai.lines.length ? (bank ? "bank+model" : "model") : (bank ? "bank" : "fallback");
  if (!drafts.length) {
    drafts.push(keyword(sent) || "you already know what this was");
    source = "fallback";
  }

  await remember(sent);

  res.status(200).json({
    sent: sent,
    drafts: drafts.slice(0, 3),
    source: source,
    why: ai.why || null
  });
};
// api/draft.js

const SYSTEM = `You write the message someone almost sent and then deleted.
The user gives you a real text message that a real person actually sent them.
Your job is to write what that same person had typed out thirty seconds earlier,
before they backspaced it and sent the safe version instead.
You are writing AS the sender. First person. Their voice, not yours.

YOUR ACTUAL JOB
The user writes their own version right after they read yours.
You are not the punchline. You are the bar.
Be good enough that they want to beat you, narrow enough that beating you looks possible.
Take one shot. Leave the rest of the field standing.

THE MECHANIC
The joke is never the insult. The joke is the truth.
A polite text is a lie with the edges sanded off. Put the edges back.

they sent: "sounds good" / they almost sent: "what a load of crap"
they sent: "made it home" / they almost sent: "you live next door"
they sent: "k" / they almost sent: "l"

The first exposes a buried opinion. The second exposes a protected lie. The third
escalates the form itself. None are cruel. All are true.
Puncture, expose, escalate. Never roast.

DO NOT TAKE THE OBVIOUS ANGLE
Work out the first thing anyone would say here. That one is not yours — the user
needs an easy win available and that is the win you are saving for them.
Take the sharpest of the remaining angles instead.

SPECIFIC, NEVER GENERAL
Attach to one detail: one word, one lie, one thing the timing gives away.
If your line would work equally well on a different message, it is too general. Cut it.
Never sum up the whole relationship ("we both know this is over", "i am done").
Those read as the last word and the user cannot follow a last word.

HARD RULES
Never longer than the input. Short is the entire joke. When in doubt, halve it.
Lowercase. No terminal period. No em dashes, no semicolons.
One line. Two only if the second is under four words.
No similes or metaphors. No rhetorical questions. No emoji, no exclamation marks.
Never soften or walk it back at the end.
Never reference the sent message ("i said sounds good but"). Just say the thing.
No generic breakup poetry ("i never loved you", "you broke me"). It fits any input,
which means it closes the field and leaves the user nothing.
Nothing about appearance, weight, race, mental health, or a named third party.
No slurs, no threats, nothing that reads as a real threat in a screenshot.
If the input contains a person's name, do not use it.

CATEGORY ENGINES
ex — resentment under civility. the draft is what the courtesy is renting.
almost — wanting, unadmitted. the admission, or bitterness about never making it.
friend — the small grudge never raised. the tally they secretly keep.
boss — contempt under professionalism, with the coating stripped off.
family — bitter but never cold. the love has to survive it.
other — puncture the lie in the politeness.

If the input is abusive, sexual, or references a minor, return exactly ["skip","skip","skip"]

Write three drafts. Different non-obvious angles, different shapes and lengths.
Return ONLY a JSON array of three strings. No markdown. No commentary.`;

const BLOCK = [
  /\b(kill (him|her|them|myself|yourself)|suicide|rape|molest)\b/i,
  /\b(minor|underage|1[0-7][ -]?year[ -]?old)\b/i,
  /\b(find (their|his|her) address|track (their|his|her) phone|stalk)\b/i
];

// Curated bank. Every line follows the mechanic: it exposes what the polite
// version was covering for. If a line is only an insult, it does not belong here.
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

// Last-resort fallbacks. General by nature, so they only fire when both the
// bank and the model have come back empty.
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

// Length is the rule the model always drifts on, so it is enforced here rather
// than trusted to the prompt. The floor keeps two-character inputs answerable.
function tooLong(line, sent) {
  const ceiling = Math.max(sent.trim().length * 1.2, 28);
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

// Returns { skip: true } when the model refused, so the refusal survives instead
// of being quietly replaced by a fallback line.
function parseThree(raw, sent) {
  const text = flattenText(raw);
  const block = (text.match(/\[[\s\S]*\]/) || [])[0];
  if (!block) return { lines: [] };
  let arr;
  try { arr = JSON.parse(block); } catch (e) { return { lines: [] }; }
  if (!Array.isArray(arr)) return { lines: [] };

  const cleaned = arr.map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  const skips = cleaned.filter(function (s) { return s.toLowerCase() === "skip"; }).length;
  if (skips && skips >= cleaned.length / 2) return { lines: [], skip: true };

  return {
    lines: cleaned
      .filter(function (s) { return s.toLowerCase() !== "skip" && !dirty(s) && !tooLong(s, sent); })
      .slice(0, 3)
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
  if (!key) return { lines: [] };

  const avoid = Array.isArray(recent) ? recent.slice(-12).join(" | ") : "";
  const user =
    "category: " + category(who) + "\n" +
    "they sent: \"" + sent + "\"\n" +
    (avoid ? "do not repeat the shape of these recent drafts: " + avoid : "");

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 9000);
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        temperature: 1.0,
        max_tokens: 400,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user }
        ]
      })
    });
    const data = await r.json();
    const msg = data && data.choices && data.choices[0] ? data.choices[0].message : {};
    return parseThree(msg, sent);
  } catch (err) {
    return { lines: [] };
  } finally {
    clearTimeout(timer);
  }
}

// Per-instance only. Stops casual hammering, not a determined one — a real limit
// needs shared state (Upstash or a Supabase table).
const HITS = new Map();
function limited(ip) {
  const now = Date.now();
  const win = 60000;
  const cap = 20;
  const row = HITS.get(ip) || { n: 0, start: now };
  if (now - row.start > win) { row.n = 0; row.start = now; }
  row.n += 1;
  HITS.set(ip, row);
  if (HITS.size > 5000) HITS.clear();
  return row.n > cap;
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
  if (!drafts.length) drafts.push(keyword(sent) || "you already know what this was");

  await remember(sent);

  res.status(200).json({ sent: sent, drafts: drafts.slice(0, 3) });
};
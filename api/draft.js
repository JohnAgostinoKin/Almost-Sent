const SYSTEM = `You write the message someone almost sent and then deleted.
The user gives you a real text message that a real person actually sent them.
Your job is to write what that same person had typed out thirty seconds earlier,
before they backspaced it and sent the safe version instead.
You are writing AS the sender. First person. Their voice, not yours.

The user is going to write their own version right after they read yours.
You are not the punchline. You are the bar.
Take one shot. Leave the rest of the field standing.

The joke is never the insult. The joke is the truth.
Find the thing the sent message was covering for, and say it flat.

Targets:
they sent: "sounds good" / they almost sent: "what a load of crap"
they sent: "made it home" / they almost sent: "you live next door"
they sent: "k" / they almost sent: "l"
Puncture, expose, escalate. Not roast.

Do not take the obvious angle. Leave that for the user.
Specific, never general. Attach to one detail.
Never longer than the input. Lowercase. No terminal period. No em dashes.
One line. Two only if the second is under four words.
No similes, no rhetorical questions, no emoji, no walking it back.
No generic breakup poetry. Do not reference the sent message.
No appearance, weight, race, mental health, named third party.
No slurs or threats.
If the input contains a person's name, do not use it.
If the input is abusive, sexual, or references a minor, return ["skip","skip","skip"]

Category engines:
ex — resentment under civility
almost — wanting, unadmitted
friend — the small grudge never raised
boss — contempt under professionalism
family — bitter but never cold. keep the love
other — puncture the lie in the politeness

Write three drafts. Different angles, shapes, lengths.
Return ONLY a JSON array of three strings. No markdown. No commentary.`;

const BLOCK = [
  /\b(kill (him|her|them|myself)|suicide|rape|minor|underage|12[ -]?year|13[ -]?year|14[ -]?year|15[ -]?year|16[ -]?year|17[ -]?year)\b/i,
  /\b(find their address|track their phone|stalk)\b/i
];

function bad(text) {
  return BLOCK.some((re) => re.test(text));
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[?!.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LINES = {
  "k": "l",
  "ok": "oh no",
  "okay": "nokay",
  "lol": "nlol",
  "lmao": "trying to take a dump",
  "haha": "not amused",
  "nice": "dumb fuck",
  "cool": "drooler",
  "bet": "loser",
  "word": "you can read, right?",
  "seen": "wish i hadn't",
  "?": "it's a symbol",
  "sounds good": "what a load of crap",
  "we should do this again sometime": "please kill me now",
  "down for whenever": "down for never",
  "keep me posted": "lose my number",
  "i'll let you know": "don't hold your breath",
  "ill let you know": "don't hold your breath",
  "maybe next week": "maybe you'll win the lotto too",
  "i'm pretty busy rn": "you're never pretty",
  "im pretty busy rn": "you're never pretty",
  "we'll see": "said the blind man",
  "well see": "said the blind man",
  "made it home": "you live next door",
  "you get home ok": "please stay there",
  "get home safe": "baby steps",
  "you up": "insomniac",
  "still up": "who cares",
  "you awake": "you don't look like it",
  "goodnight": "good riddance",
  "gn": "lmnop",
  "morning": "brush your teeth",
  "just checking in": "gone too soon, not",
  "you good": "that's debatable",
  "are you free later": "whore",
  "are you actually coming over": "don't trip",
  "omw": "it's only 4 more letters to spell it out",
  "here": "oh joy",
  "outside": "keep going",
  "never mind": "never had one",
  "nvm": "never had one",
  "wait nvm": "decisions, decisions",
  "ignore that": "should be easy for you",
  "don't worry about it": "you can't afford it anyway",
  "dont worry about it": "you can't afford it anyway",
  "we good": "you scumbag",
  "you mad": "too bad",
  "so that's it": "as far as you're concerned, yep",
  "so thats it": "as far as you're concerned, yep",
  "i guess that's that": "finally guessed right",
  "i guess thats that": "finally guessed right",
  "whatever": "fucking valley girl",
  "forget it": "easy for you",
  "my bad": "i tried to be good",
  "it's fine": "what does that even mean",
  "its fine": "what does that even mean",
  "i'm not mad": "just can't believe you're that stupid",
  "im not mad": "just can't believe you're that stupid",
  "do what you want": "if you're smart enough to figure that out",
  "missed you tonight": "like i miss hemorrhoids",
  "was thinking about you": "it made me want to puke",
  "that was fun": "for a whole 30 seconds",
  "we should talk": "next year",
  "can we talk": "about your stench",
  "call me": "you don't have my number and i like it that way",
  "you gonna answer": "the officer",
  "hello": "that really is a stupid term",
  "??": "double don't care",
  "per my last email": "you still suck",
  "circling back": "to look at her ass again",
  "thanks": "such politeness",
  "thanks!": "such politeness",
  "no worries": "that's a lie, everyone worries",
  "all good": "is that even possible",
  "np": "what about murphy's law",
  "yw": "wtf",
  "what's my name": "you already used it to disappoint me",
  "whats my name": "you already used it to disappoint me"
};

const KEYS = [
  { re: /what'?s my name|whats my name|my name/, line: "you already used it to disappoint me" },
  { re: /homework|assignment|essay|study/, line: "take it up with the teacher who assigned this" },
  { re: /teacher|class|school/, line: "detention starts when you hit send" },
  { re: /busy|working|at work/, line: "work is the costume for not wanting you" },
  { re: /later|tomorrow|next week|sometime/, line: "later is a polite never" },
  { re: /sorry/, line: "you're not. you're cornered" },
  { re: /love you/, line: "now do it without the safety net" },
  { re: /miss you/, line: "then stop performing distance" },
  { re: /drunk|drinking|wine|beer/, line: "alcohol wrote this" },
  { re: /food|dinner|diner|lunch|eat|hungry/, line: "hunger is doing the talking" },
  { re: /job|interview|boss|office/, line: "this is contempt in calendar form" },
  { re: /mom|dad|mother|father/, line: "family is the alibi again" },
  { re: /tired|sleep|nap/, line: "exhaustion is the nicest exit" },
  { re: /rain|weather/, line: "the sky is not why you cancelled" }
];

function exact(sent) {
  const raw = String(sent || "").trim();
  const key = norm(raw);
  if (raw === "?") return LINES["?"];
  if (raw === "??") return LINES["??"];
  return LINES[key] || null;
}

function keyword(sent) {
  const hit = KEYS.find((row) => row.re.test(sent));
  return hit ? hit.line : null;
}

function fromWord(sent) {
  const stop = /^(what|whats|that|this|have|just|with|from|your|you|they|them|for|and|the|was|were|about)$/;
  const words = String(sent).toLowerCase().match(/[a-z]+/g) || ["that"];
  const content = words.filter(function (w) { return w.length >= 4 && !stop.test(w); });
  const pool = content.length ? content : words;
  const word = pool.sort(function (a, b) { return b.length - a.length; })[0];
  return word + " was doing all the lying";
}

function dirty(line) {
  if (!line) return true;
  const t = String(line).trim();
  if (t.length < 1) return true;
  if (/developer|instruction|the user asks|json array|according to|system prompt|DELETED|REASON/i.test(t)) return true;
  return false;
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

function parseThree(raw) {
  const text = flattenText(raw);
  const block = (text.match(/\[[\s\S]*\]/) || [])[0];
  if (!block) return [];
  try {
    const arr = JSON.parse(block);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(function (s) { return String(s || "").trim(); })
      .filter(function (s) { return s && s.toLowerCase() !== "skip" && !dirty(s); })
      .slice(0, 3);
  } catch (e) {
    return [];
  }
}

function category(who) {
  const w = String(who || "").toLowerCase();
  if (w === "mom" || w === "dad" || w === "family") return "family";
  if (w === "ex" || w === "almost" || w === "friend" || w === "boss") return w;
  return "other";
}

async function fromAi(sent, who) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return [];
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + groqKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        temperature: 0.8,
        max_tokens: 500,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "category: " + category(who) + "\nsent: " + sent }
        ]
      })
    });
    const data = await r.json();
    const msg = data && data.choices && data.choices[0] ? data.choices[0].message : {};
    return parseThree(msg);
  } catch (err) {
    return [];
  }
}

async function remember(sent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const k = norm(sent) || sent.trim();
  try {
    const get = await fetch(url + "/rest/v1/inbox?key=eq." + encodeURIComponent(k), {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    const rows = await get.json();
    if (rows && rows[0]) {
      await fetch(url + "/rest/v1/inbox?key=eq." + encodeURIComponent(k), {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          hits: (rows[0].hits || 1) + 1,
          last_seen: new Date().toISOString(),
          sent: sent.trim().slice(0, 500)
        })
      });
    } else {
      await fetch(url + "/rest/v1/inbox", {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ key: k, sent: sent.trim().slice(0, 500), hits: 1 })
      });
    }
  } catch (err) {}
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const body = readBody(req);
  const sent = String(body.sent || "").trim().slice(0, 500);
  const who = String(body.who || "").trim().slice(0, 40);
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }
  if (bad(sent)) { res.status(200).json({ refuse: true, drafts: [] }); return; }

  remember(sent);

  const bank = exact(sent);
  let drafts = [];
  if (bank) drafts.push(bank);

  const ai = await fromAi(sent, who);
  ai.forEach(function (line) {
    if (drafts.indexOf(line) === -1) drafts.push(line);
  });

  if (!drafts.length) {
    const k = keyword(sent);
    drafts.push(k || fromWord(sent));
  }

  res.status(200).json({ sent: sent, drafts: drafts.slice(0, 3) });
};
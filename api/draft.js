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
  "yw": "wtf"
};

const KEYS = [
  { re: /homework|assignment|essay|study/, line: "take it up with the teacher who assigned this" },
  { re: /teacher|class|school/, line: "detention starts when you hit send" },
  { re: /busy|working|at work/, line: "work is the costume for not wanting you" },
  { re: /later|tomorrow|next week|sometime/, line: "later is a polite never" },
  { re: /sorry/, line: "you're not. you're cornered." },
  { re: /love you/, line: "now do it without the safety net" },
  { re: /miss you/, line: "then stop performing distance" },
  { re: /drunk|drinking|wine|beer/, line: "alcohol wrote this. you just held the phone." },
  { re: /drive|driving|uber|lyft/, line: "texting this was the unsafe part" },
  { re: /food|dinner|lunch|eat/, line: "hunger is doing the emotional labor" },
  { re: /job|interview|boss|office/, line: "corporate voice in a personal crime" },
  { re: /mom|dad|mother|father/, line: "family is the alibi again" },
  { re: /dog|cat|pet/, line: "the animal has better boundaries" },
  { re: /tired|sleep|nap/, line: "exhaustion is the nicest way to leave" },
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
  const hit = KEYS.find((k) => k.re.test(sent));
  return hit ? hit.line : null;
}

function fromWord(sent) {
  const words = String(sent).toLowerCase().match(/[a-z']{4,}/g) || ["that"];
  const word = words.sort((a, b) => b.length - a.length)[0];
  return word + " is doing too much work in a text that small";
}

async function fromAi(sent) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        temperature: 0.8,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content: "Roast the incoming text in ONE short lowercase line. Mean, funny, specific. If it mentions homework or school, blame a bad teacher. No quotes. No labels. No explanation."
          },
          { role: "user", content: sent }
        ]
      })
    });
    const data = await r.json();
    const msg = data?.choices?.[0]?.message || {};
    let text = msg.content || msg.reasoning || "";
    if (Array.isArray(text)) text = text.map((p) => p.text || "").join(" ");
    text = String(text).trim().split("\n").filter(Boolean).pop() || "";
    text = text.replace(/^["']|["']$/g, "").slice(0, 120);
    if (!text || /DELETED|REASON|homework or school/i.test(text)) return null;
    return text;
  } catch (e) {
    return null;
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
  } catch (e) {}
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const body = readBody(req);
  const sent = String(body.sent || "").trim().slice(0, 500);
  if (!sent) { res.status(400).json({ error: "paste a text" }); return; }
  if (bad(sent)) { res.status(200).json({ refuse: true, reason: "not this one." }); return; }

  remember(sent);

  let deleted = exact(sent);
  let source = "bank";
  if (!deleted) {
    deleted = keyword(sent);
    source = deleted ? "keyword" : source;
  }
  if (!deleted) {
    deleted = await fromAi(sent);
    source = deleted ? "ai" : source;
  }
  if (!deleted) {
    deleted = fromWord(sent);
    source = "word";
  }

  res.status(200).json({ sent, deleted, source });
};
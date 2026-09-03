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

const FALLBACK = [
  "that wasn't nothing",
  "say what you meant",
  "this is the costume version"
];

function draft(sent) {
  const key = norm(sent);
  if (LINES[key]) return LINES[key];
  if (sent.trim() === "?") return LINES["?"];
  if (sent.trim() === "??") return LINES["??"];
  return FALLBACK[key.length % FALLBACK.length];
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

  res.status(200).json({
    sent,
    deleted: draft(sent),
    temperature: "cowardly"
  });
};
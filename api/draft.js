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

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pick(list, seed) {
  return list[hash(seed) % list.length];
}

const BANK = {
  cold: [
    { deleted: "the one letter was on purpose.", reason: "they picked the smallest knife in the drawer." },
    { deleted: "i saw it. i'm not making it a scene.", reason: "k already was the scene." }
  ],
  later: [
    { deleted: "thursday. pick a time.", reason: "sometime is how you cancel without cancelling." },
    { deleted: "say when. i'll actually show up.", reason: "sounds good is a polite no with a smile." }
  ],
  home: [
    { deleted: "stay on the line till you turn the key.", reason: "they made it a check-in so it would not be a plea." },
    { deleted: "text when the door shuts.", reason: "home is safer to ask about than the night." }
  ],
  night: [
    { deleted: "don't sleep on this.", reason: "goodnight is how you leave a fight unfinished." },
    { deleted: "i'm still in that text.", reason: "they ended the day instead of the sentence." }
  ],
  awake: [
    { deleted: "if you're up, just say so.", reason: "a question is cheaper than i miss you." },
    { deleted: "i can see you're online.", reason: "that's not an accusation. it is." }
  ],
  come: [
    { deleted: "come over. no plan, just the door.", reason: "they asked if it was happening so they would not have to want it." },
    { deleted: "i'll leave it unlocked.", reason: "coming over was too much wanting in one line." }
  ],
  generic: [
    { deleted: "that wasn't nothing.", reason: "they sent the version that can be denied tomorrow." },
    { deleted: "say what you meant.", reason: "they didn't. that's the point." },
    { deleted: "i almost made this honest.", reason: "honesty does not screenshot as well as almost." },
    { deleted: "this is me being a coward in public.", reason: "the sent text is the costume." }
  ]
};

function bankDraft(sent, who) {
  const s = sent.toLowerCase();
  let pool = BANK.generic;
  if (/\bk\b|ok$|okay$/.test(s)) pool = BANK.cold;
  else if (/sound|sometime|we should|later/.test(s)) pool = BANK.later;
  else if (/home|made it/.test(s)) pool = BANK.home;
  else if (/good ?night|gn\b|sleep/.test(s)) pool = BANK.night;
  else if (/awake|up\?|you up/.test(s)) pool = BANK.awake;
  else if (/coming|come over|omw|on my way/.test(s)) pool = BANK.come;
  const card = pick(pool, sent + "|" + who);
  return {
    sent,
    deleted: card.deleted,
    reason: card.reason,
    temperature: "cowardly"
  };
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
  if (bad(sent) || bad(who)) { res.status(200).json({ refuse: true, reason: "not this one." }); return; }

  res.status(200).json(bankDraft(sent, who));
};
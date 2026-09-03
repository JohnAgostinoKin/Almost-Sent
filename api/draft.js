const SYSTEM = `Write a fictional deleted text message.

End your reply with exactly:
DELETED: <short text they almost sent>
REASON: <one sentence>
TEMP: cowardly

The last three lines must be those labels. Everything before that is fine.`;

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

function flattenText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (typeof value === "object") {
    return [value.content, value.text, value.reasoning].map(flattenText).join("\n");
  }
  return "";
}

function lastMatch(text, re) {
  const all = [...String(text).matchAll(re)];
  return all.length ? all[all.length - 1][1].trim() : "";
}

function parseLabeled(raw) {
  const text = flattenText(raw);
  return {
    deleted: lastMatch(text, /DELETED:\s*([^\n]+)/gi),
    reason: lastMatch(text, /REASON:\s*([^\n]+)/gi),
    temperature: lastMatch(text, /TEMP:\s*([^\n]+)/gi)
  };
}

function dirty(text) {
  if (!text) return true;
  if (text.length > 140) return true;
  return /the sent text|we imagine|example:|labels|json|incoming|optional|template|bracket/i.test(text);
}

function mock(sent, who) {
  return {
    sent,
    deleted: "text me when you get in.\ni said it softer than that first.",
    reason: who ? `they kept ${who} at the exact distance that still hurts.` : "they wanted the door open without walking through it.",
    temperature: "warm"
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

  const key = process.env.GROQ_API_KEY;
  if (!key) { res.status(200).json(mock(sent, who)); return; }

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        temperature: 0.7,
        max_tokens: 900,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `sent: ${sent}\nfrom: ${who || "unknown"}` }
        ]
      })
    });
    const data = await r.json();
    const parsed = parseLabeled(data?.choices?.[0]?.message);
    if (dirty(parsed.deleted)) {
      res.status(200).json(mock(sent, who));
      return;
    }
    res.status(200).json({
      sent,
      deleted: parsed.deleted.slice(0, 280),
      reason: (dirty(parsed.reason) ? "they sent the safer sentence." : parsed.reason).slice(0, 180),
      temperature: parsed.temperature || "cowardly"
    });
  } catch (err) {
    res.status(200).json(mock(sent, who));
  }
};
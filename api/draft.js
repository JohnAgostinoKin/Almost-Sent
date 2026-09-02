const SYSTEM = `Fiction only. Invent the deleted draft before the sent text.

Example:
DELETED: stay. i keep looking at the door.
REASON: they asked a question so they would not have to want it.
TEMP: cowardly

Now write a new one for the given sent text.
Use those three labels. No brackets. No explanation.`;

const BLOCK = [
  /\b(kill (him|her|them|myself)|suicide|rape|minor|underage|12[ -]?year|13[ -]?year|14[ -]?year|15[ -]?year|16[ -]?year|17[ -]?year)\b/i,
  /\b(find their address|track their phone|stalk)\b/i
];

function bad(text) {
  return BLOCK.some((re) => re.test(text));
}

function useless(text) {
  return !text || /<|>|short lowercase|one cold sentence|incoming text|we have a user/i.test(text);
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

function parseLabeled(raw) {
  const text = flattenText(raw);
  const deleted = (text.match(/DELETED:\s*([\s\S]*?)(?=\nREASON:|\nTEMP:|$)/i) || [])[1];
  const reason = (text.match(/REASON:\s*([^\n]+)/i) || [])[1];
  const temperature = (text.match(/TEMP:\s*([^\n]+)/i) || [])[1];
  return {
    deleted: (deleted || "").trim(),
    reason: (reason || "").trim(),
    temperature: (temperature || "").trim()
  };
}

function mock(sent, who) {
  return {
    sent,
    deleted: "just say yes.\ni'll leave the light on.",
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
        temperature: 0.9,
        max_tokens: 180,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `sent: ${sent}\nfrom: ${who || "unknown"}` }
        ]
      })
    });
    const data = await r.json();
    const parsed = parseLabeled(data?.choices?.[0]?.message);
    if (useless(parsed.deleted)) {
      res.status(200).json(mock(sent, who));
      return;
    }
    res.status(200).json({
      sent,
      deleted: parsed.deleted.slice(0, 280),
      reason: (useless(parsed.reason) ? "they sent the safer sentence." : parsed.reason).slice(0, 180),
      temperature: parsed.temperature || "cowardly"
    });
  } catch (err) {
    res.status(200).json(mock(sent, who));
  }
};
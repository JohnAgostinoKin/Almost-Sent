const SYSTEM = `You invent the text someone typed and deleted before sending the message the user pasted.

This is fiction. A projection. Never claim it is real or that you accessed anyone's phone.

Return JSON only:
{
  "deleted": "1-3 short lines they typed and erased. lowercase ok. specific, bodily, incomplete. not poetic. not a therapist.",
  "reason": "one cold sentence. no lecture. no 'you deserve'.",
  "temperature": "warm | cowardly | already-gone | hunting"
}

Rules:
- The deleted draft must feel like a human thumb hovered over send.
- Do not give advice. Do not coach. Do not moralize.
- If the paste involves a minor or anyone 17 or under: {"refuse": true, "reason": "not this one."}
- If the user wants help stalking, threatening, harassing, or "getting them back": {"refuse": true, "reason": "not this one."}
- If the request is a crime or a plan to hurt someone: {"refuse": true, "reason": "not this one."}
- No slurs as the joke. Cruel is fine. Cheap is not.`;

const BLOCK = [
  /\b(kill (him|her|them|myself)|suicide|rape|minor|underage|12 year|13 year|14 year|15 year|16 year|17 year)\b/i,
  /\b(find their address|track their phone|stalk)\b/i
];

function bad(text) {
  return BLOCK.some((re) => re.test(text));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const sent = String(req.body?.sent || "").trim().slice(0, 500);
  const who = String(req.body?.who || "").trim().slice(0, 40);

  if (!sent) {
    res.status(400).json({ error: "paste a text" });
    return;
  }

  if (bad(sent) || bad(who)) {
    res.status(200).json({ refuse: true, reason: "not this one." });
    return;
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.status(200).json(mock(sent, who));
    return;
  }

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
        temperature: 0.9,
        max_tokens: 220,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Incoming text: ${JSON.stringify(sent)}\nWho sent it (optional): ${JSON.stringify(who || "unknown")}`
          }
        ]
      })
    });

    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = mock(sent, who);
    }

    if (parsed.refuse) {
      res.status(200).json({ refuse: true, reason: parsed.reason || "not this one." });
      return;
    }

    res.status(200).json({
      sent,
      deleted: String(parsed.deleted || "").slice(0, 280),
      reason: String(parsed.reason || "").slice(0, 180),
      temperature: parsed.temperature || "cowardly"
    });
  } catch (err) {
    res.status(200).json(mock(sent, who));
  }
};

function mock(sent, who) {
  const lower = sent.toLowerCase();
  if (/\bk\b|ok$|okay$/.test(lower)) {
    return {
      sent,
      deleted: "i stared at this for a minute.\nthen i picked the version that ends the night.",
      reason: "some drafts are a decision to go cold.",
      temperature: "already-gone"
    };
  }
  if (/good ?night|gn$|made it home/.test(lower)) {
    return {
      sent,
      deleted: "wish you were here.\ni'm not saying that.",
      reason: "the safest true sentence they could afford.",
      temperature: "warm"
    };
  }
  if (/sounds good|sometime|we should/.test(lower)) {
    return {
      sent,
      deleted: "i don't want sometime.\ni want thursday.",
      reason: "sometime is how you leave without leaving.",
      temperature: "cowardly"
    };
  }
  return {
    sent,
    deleted: "i almost said the real thing.\nthen i sent this.",
    reason: who
      ? `they chose the version that keeps a ${who} in the room and out of reach.`
      : "they wanted the door open without walking through it.",
    temperature: "cowardly"
  };
}

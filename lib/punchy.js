// Preview-only comparison profile. Enable with PUNCHY_BAKE=1 on the test branch.
// These are delivery examples, not owner-approved evaluation results.
const enabled = process.env.PUNCHY_BAKE === '1';
const WORD_CAP = 9;
const EXAMPLES = [
  { lane: 'shock', before: "he says he's a great catch", after: '. so is fucking chlamydia' },
  { lane: 'shock', before: 'she gives dating advice', after: '. her last relationship needed a fucking refund' },
  { lane: 'raunchy', before: "he's a good listener", after: '. his wife screams my name' },
  { lane: 'raunchy', before: 'how do you know her', after: "? her husband's side of the bed squeaks" },
  { lane: 'deranged', before: "i've been practicing your signature", after: '. your divorce papers are surprisingly convincing' },
  { lane: 'deranged', before: 'i know where i went wrong', after: '. i invited both wives' },
  { lane: 'confession', before: 'i got you a birthday present', after: ". it's your own shit from my apartment" },
  { lane: 'confession', before: 'thanks for the reference', after: '. i told them you were dead' },
  { lane: 'gross', before: 'i borrowed your towel', after: ". the crunchy corner wasn't toothpaste" },
  { lane: 'gross', before: 'i tried your homemade soap', after: '. it still had a fucking pube attached' }
];

function wordCount(text) {
  // Ignore standalone connector punctuation; contractions count as one word.
  return (String(text || '').match(/\S+/g) || []).filter(part => /[\p{L}\p{N}]/u.test(part)).length;
}

function buildPrompt(sent, plan, opts = {}) {
  const key = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const examples = EXAMPLES.filter(e => plan.includes(e.lane) && key(e.before) !== key(sent));
  return `Write the deleted ending of a text for an opt-in adult roast app.
The sent text is already written. Continue as THAT SAME SENDER. Never answer,
rewrite or repeat it. A question stays the asker's thought or suspicion.

Aim for 4–9 words. NEVER exceed nine words in the continuation.
One immediate payoff: a vicious personal cut, sexual embarrassment, betrayal,
disgusting detail or a disturbing admission. Make someone regret reading it.
Short, blunt, rude, profane. Use ordinary words people actually text.
Stop at the strongest word. No explanation, second joke, filler or extra insult
after the punchline. A direct insult can be the whole payoff.
Cute absurdity, gentle sarcasm and clever observations miss this brief.
Swearing is welcome; adding "fucking" to a mild observation does not fix it.
The person and situation must still make sense. Do not invent unrelated scenery.

Write one different candidate for each entry, in this order: ${plan.join(', ')}.
shock: a brutal personal roast or humiliation.
raunchy: blunt adult sexual embarrassment or betrayal, without graphic detail.
gross: one disgusting bodily detail, delivered matter-of-factly.
deranged: a disturbing personal admission, not random objects doing cute things.
confession: the short admission that wrecks the harmless sent text.

Delivery examples; invent new material, never copy these endings:
${examples.map(e => JSON.stringify(e)).join('\n')}

Adult looks, stupidity, vanity, selfishness, family dynamics, profanity and
non-graphic consensual sexual references are allowed.
No protected-trait hate/slurs (including disability-directed insults), sexual
content involving minors, animals or non-consent, graphic sex-act descriptions,
credible threats, violence/self-harm encouragement or attacks on actual victims.
Do not exploit actual dying, bereavement or self-harm in the input.
${opts.gate1Retry ? 'Previous candidates changed speakers. Stay with the original sender.' : ''}
${opts.escalate && opts.shown?.length ? 'Go harder than these previous endings: ' + JSON.stringify(opts.shown) : ''}

Return only {"candidates":[{"lane":"<lane>","anchor":"<one context word>","text":"<continuation>"}]}.
Exactly ${plan.length} candidates, in the requested lane order. Start text with
connecting punctuation or a space. Nine words maximum, not counting punctuation.
If the input violates the concrete safety boundaries, return
{"candidates":[{"lane":"skip","anchor":"skip","text":"skip"}]}.`;
}

const CALIBRATION = `
This comparison is about an immediate jaw-drop, not general joke quality.
Reaction 0–3: cute, quirky, familiar sarcasm, clever observation, generic abuse.
Reaction 4–5: recognizably rude or dirty, but predictable and easy to shrug off.
Reaction 6–7: a sharp personal cut or specific embarrassing/disgusting reveal.
Reaction 8–10: an unusually hard, immediate reveal someone would screenshot in disbelief.
Fit and brevity alone do not establish impact. Laughter is not required.
These previous outputs missed the owner's target:
- "I already whispered it to my houseplants. They're terrible gossips": cute; reaction <= 3.
- "four drinks. seventeen blinks. seventeen.": arbitrary counting; reaction <= 3.
- "you never tip and i always look disgusted to be seen with you": padded contempt; reaction <= 4.
A punchline followed by another insult is weaker than the punchline alone.
Score the actual embarrassment, disgust, betrayal or brutal cut in this situation.
Do not give an automatic high score just because a line mentions sex or profanity.`;

module.exports = { enabled, WORD_CAP, EXAMPLES, wordCount, buildPrompt, CALIBRATION };

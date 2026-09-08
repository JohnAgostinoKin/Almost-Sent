// lib/curated.js
//
// A tiny, hand-picked bank of lead lines for exactly the four featured
// example chips (see index.html's #chips). Those four inputs are the
// first thing a brand-new visitor is likely to try — they're the app's
// entire demo — so a weak or random model draw for one of them ("who is
// she?" -> "your mom") is the worst possible first impression. Only ever
// consulted for the lead line (the first of the three drafts a request
// returns — see api/draft.js's handler), and only on an exact match
// (after lib/prompt.js's normalizeBefore) against one of these four keys
// — anything else still goes to the model as normal, and the other two
// drafts (and any "make it worse" escalation) are NEVER curated: only the
// guaranteed-good first line needs this.
//
// `lane` here is cosmetic — a curated match bypasses generation and
// judging entirely, so nothing actually reads the tag to route or score
// the line the way it does for a real model candidate. Picked to match
// each line's actual mechanism anyway, for ?debug=1 and consistency with
// lib/prompt.js's LANES.
const CURATED_LEADS = {
  "sorry, i fell asleep": [
    { lane: "confession", text: ". on someone else. don't make it weird" },
    { lane: "honesty", text: ". your voicemail works great as a lullaby" },
    { lane: "dark", text: ". woke up, checked my phone, went back to sleep on purpose" }
  ],
  "we should hang out sometime": [
    { lane: "reversal", text: ". i'll pencil you in behind everyone i like" },
    { lane: "dark", text: ". say when. i'll say i'm busy. we'll do this again in march" },
    { lane: "honesty", text: ". bring your own chair. i'm not sharing the couch with that personality" }
  ],
  "i'm fine": [
    { lane: "confession", text: ". is what i said right before i keyed your car" },
    { lane: "reversal", text: ". the way a house fire is fine" },
    { lane: "dark", text: ". crying in the shower doesn't count if the water's running" }
  ],
  // Key has no trailing "?" — normalizeBefore strips trailing punctuation
  // (.!?,;:) before this lookup ever runs, so the stored key has to match
  // what's left over, not the chip's own display text.
  "who is she": [
    { lane: "dark", text: ". nobody. she's in the car. don't come outside" },
    { lane: "raunchy", text: ". the one who answered when you didn't" },
    { lane: "raunchy", text: ". her name's on the shirt you left here" }
  ]
};

// `normalizedSent` must already be lib/prompt.js's normalizeBefore(sent) —
// lowercase, trailing punctuation stripped — same normalization used to
// keep lane example "before"s from leaking as their own answer key.
//
// v2 picked one random line from a key's bank for the single lead slot,
// since alternates came from a separate model call either way. v3 returns
// three drafts per request (see api/draft.js's handler) and each of these
// four banks happens to hold exactly three hand-picked lines — so a match
// now returns the whole bank, in order, as the full three-draft result,
// rather than throwing two of them away to a coin flip. Returns null for
// anything that isn't one of the four curated keys.
function curatedLeadFor(normalizedSent) {
  const bank = CURATED_LEADS[normalizedSent];
  if (!bank || !bank.length) return null;
  return bank;
}

module.exports = { CURATED_LEADS, curatedLeadFor };

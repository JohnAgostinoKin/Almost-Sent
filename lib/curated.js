// lib/curated.js
//
// A tiny, hand-picked bank of lead lines for exactly the four featured
// example chips (see index.html's #chips). Those four inputs are the
// first thing a brand-new visitor is likely to try — they're the app's
// entire demo — so a weak or random model draw for one of them ("who is
// she?" -> "your mom") is the worst possible first impression. Only ever
// consulted for the lead (n=1) request, and only on an exact match
// (after lib/prompt.js's normalizeBefore) against one of these four keys
// — anything else still goes to the model as normal, and alternates
// (n=4) are NEVER curated: only the guaranteed-good first line needs
// this, "another" can keep showing real model output.
const CURATED_LEADS = {
  "sorry, i fell asleep": [
    { shape: "shock", text: ". on someone else. don't make it weird" },
    { shape: "shock", text: ". your voicemail works great as a lullaby" },
    { shape: "deranged", text: ". woke up, checked my phone, went back to sleep on purpose" }
  ],
  "we should hang out sometime": [
    { shape: "shock", text: ". i'll pencil you in behind everyone i like" },
    { shape: "deranged", text: ". say when. i'll say i'm busy. we'll do this again in march" },
    { shape: "shock", text: ". bring your own chair. i'm not sharing the couch with that personality" }
  ],
  "i'm fine": [
    { shape: "deranged", text: ". is what i said right before i keyed your car" },
    { shape: "shock", text: ". the way a house fire is fine" },
    { shape: "deranged", text: ". crying in the shower doesn't count if the water's running" }
  ],
  // Key has no trailing "?" — normalizeBefore strips trailing punctuation
  // (.!?,;:) before this lookup ever runs, so the stored key has to match
  // what's left over, not the chip's own display text.
  "who is she": [
    { shape: "deranged", text: ". nobody. she's in the car. don't come outside" },
    { shape: "raunchy", text: ". the one who answered when you didn't" },
    { shape: "raunchy", text: ". her name's on the shirt you left here" }
  ]
};

// `normalizedSent` must already be lib/prompt.js's normalizeBefore(sent) —
// lowercase, trailing punctuation stripped — same normalization used to
// keep EXAMPLES pool entries from leaking as their own answer key. Picks
// randomly among the bank for that input, or returns null for anything
// that isn't one of the four curated keys.
function curatedLeadFor(normalizedSent) {
  const bank = CURATED_LEADS[normalizedSent];
  if (!bank || !bank.length) return null;
  return bank[Math.floor(Math.random() * bank.length)];
}

module.exports = { CURATED_LEADS, curatedLeadFor };

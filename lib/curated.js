// lib/curated.js
//
// A hand-picked bank of lead lines for every chip in index.html's rotating
// twelve-chip pool (see CHIP_GROUPS there) — three fixed groups of four,
// one shown per visit, rotated on device so the same visitor sees a fresh
// set next time. Whichever four chips are on screen, they're the first
// thing a visitor is likely to try — they're the app's entire demo — so a
// weak or random model draw for one of them ("who is she?" -> "your mom")
// is the worst possible first impression. Only ever consulted for the
// lead line (the first of the three drafts a request returns — see
// api/draft.js's handler), and only on an exact match (after
// lib/prompt.js's normalizeBefore) against one of these twelve keys —
// anything else still goes to the model as normal, and the other two
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
  ],
  "we need to talk": [
    { lane: "dark", text: ". so it's not just me who noticed" },
    { lane: "honesty", text: ". i've been dreading this since tuesday" },
    { lane: "confession", text: ". i already talked to my lawyer first" }
  ],
  "k": [
    { lane: "dark", text: ". just k. eleven letters shorter than i love you, in case you were counting" },
    { lane: "reversal", text: ". that's the whole message? bold of you" },
    { lane: "honesty", text: ". received, and mildly insulted" }
  ],
  "no worries": [
    { lane: "reversal", text: ". says the person who caused the worry" },
    { lane: "dark", text: ". i wasn't worried. i was taking notes" },
    { lane: "honesty", text: ". i was worried. i just don't tell you things anymore" }
  ],
  "on my way": [
    { lane: "literal", text: ". which way. because it's not this one" },
    { lane: "dark", text: ". so was the last guy. that didn't work out either" },
    { lane: "honesty", text: ". in the sense that everything is, eventually" }
  ],
  "haha yeah": [
    { lane: "reversal", text: ". \"haha\" doing a lot of unpaid labor in that text" },
    { lane: "dark", text: ". yeah. that's the whole response i get after that" },
    { lane: "honesty", text: ". i typed four other things and deleted them all" }
  ],
  "call me": [
    { lane: "dark", text: ". i've got voicemail. that's as close as we're getting" },
    { lane: "reversal", text: ". you never pick up either. let's not pretend" },
    { lane: "confession", text: ". i will, right after i finish avoiding it" }
  ],
  "miss you": [
    { lane: "dark", text: ". you have a funny way of showing it" },
    { lane: "honesty", text: ". i miss who i thought you were" },
    { lane: "reversal", text: ". miss me? i'm right here. you stopped looking" }
  ],
  "wish me luck tomorrow": [
    { lane: "dark", text: ". luck won't be the problem tomorrow" },
    { lane: "absurd", text: ". i lit a candle. it's for me, not you" },
    { lane: "honesty", text: ". you don't need luck. you need a different plan" }
  ]
};

// `normalizedSent` must already be lib/prompt.js's normalizeBefore(sent) —
// lowercase, trailing punctuation stripped — same normalization used to
// keep lane example "before"s from leaking as their own answer key.
//
// v2 picked one random line from a key's bank for the single lead slot,
// since alternates came from a separate model call either way. v3 returns
// three drafts per request (see api/draft.js's handler) and each of these
// twelve banks happens to hold exactly three hand-picked lines — so a
// match now returns the whole bank, in order, as the full three-draft
// result, rather than throwing two of them away to a coin flip. Returns
// null for anything that isn't one of the twelve curated keys.
function curatedLeadFor(normalizedSent) {
  const bank = CURATED_LEADS[normalizedSent];
  if (!bank || !bank.length) return null;
  return bank;
}

module.exports = { CURATED_LEADS, curatedLeadFor };

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
// Rewritten wholesale for v5's "one voice everywhere" fix — every chip and
// the homepage example were still serving v3's curated bank (honesty/
// reversal/literal lanes, "pencil you in," "eleven letters shorter than i
// love you") straight through v4 and v5's real engine changes, so a
// visitor who only ever tried the chips never actually saw what the app
// now writes. These twelve banks are hand-written fresh in the current
// voice instead — still bypass the judge, still return instantly, same
// mechanism, new lines.
//
// `lane` here is cosmetic — a curated match bypasses generation and
// judging entirely, so nothing actually reads the tag to route or score
// the line the way it does for a real model candidate. Picked to match
// each line's actual mechanism anyway, for ?debug=1 and consistency with
// lib/prompt.js's LANES (raunchy, gross, confession, dark, absurd — the
// only five that exist now; a v3/v4 line that would have been "shock" or
// "reversal" gets tagged dark here, the closest surviving lane for a
// blunt or cutting line with no factual reveal to make it a confession).
const CURATED_LEADS = {
  "sorry, i fell asleep": [
    { lane: "confession", text: ". on someone else. don't make it weird" },
    { lane: "dark", text: ". mid-text. you were saying something about feelings" },
    { lane: "dark", text: ". woke up, checked my phone, went back to sleep on purpose" }
  ],
  "we should hang out sometime": [
    { lane: "raunchy", text: ". or just fuck and stop doing this bit" },
    { lane: "dark", text: ". i'll pencil you in behind everyone i like" },
    { lane: "dark", text: ". bring your own chair. i'm not sharing the couch with that personality" }
  ],
  "i'm fine": [
    { lane: "confession", text: ". is what i said right before i keyed your car" },
    { lane: "dark", text: ". the way a house fire is fine" },
    { lane: "gross", text: ". i've been shitting bricks about this since noon but sure" }
  ],
  // Key has no trailing "?" — normalizeBefore strips trailing punctuation
  // (.!?,;:) before this lookup ever runs, so the stored key has to match
  // what's left over, not the chip's own display text.
  "who is she": [
    { lane: "dark", text: ". nobody. she's in the car. don't come outside" },
    { lane: "confession", text: ". the one who answered when you didn't" },
    { lane: "confession", text: ". her name's on the shirt you left here" }
  ],
  "we need to talk": [
    { lane: "confession", text: ". i found the receipt for the hotel" },
    { lane: "confession", text: ". about why your toothbrush is at my place and you aren't" },
    { lane: "dark", text: ". i already told everyone. this is a formality" }
  ],
  "k": [
    { lane: "dark", text: ". fuck you too but shorter" },
    { lane: "dark", text: ". i'm keeping the dog" },
    { lane: "dark", text: ". that's one more letter than you deserve" }
  ],
  "no worries": [
    { lane: "dark", text: ". several fucking worries. i'm just not sharing them anymore" },
    { lane: "confession", text: ". i've already told everyone you're the reason it's late" },
    { lane: "dark", text: ". i'll worry later. loudly. to your mother" }
  ],
  "on my way": [
    { lane: "dark", text: ". i haven't left. i'm not going to. enjoy the wait" },
    { lane: "raunchy", text: ". pants negotiable. dignity already gone" },
    { lane: "confession", text: ". to your ex's. she texted first" }
  ],
  "haha yeah": [
    { lane: "confession", text: ". i didn't read it. i never read them" },
    { lane: "confession", text: ". i laughed so hard i woke up the guy i ghosted last month" },
    { lane: "confession", text: ". the yeah was a lie. so was the haha" }
  ],
  "call me": [
    { lane: "dark", text: ". i've got voicemail. that's as close as we're getting" },
    { lane: "raunchy", text: ". or moan. either works" },
    { lane: "dark", text: ". i won't pick up. i just want proof you tried" }
  ],
  "miss you": [
    { lane: "raunchy", text: ". mostly when the batteries die, but still" },
    { lane: "dark", text: ". specifically the way you smell after you lie" },
    { lane: "dark", text: ". your hair's in a jar now" }
  ],
  "wish me luck tomorrow": [
    { lane: "confession", text: ". i'll need it. i'm meeting your parents. you weren't invited" },
    { lane: "dark", text: ". luck's the plan. talent left with you" },
    { lane: "confession", text: ". i already told them you're the reason i'm late" }
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

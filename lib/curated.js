// Hand-written first impressions for the twelve homepage demo chips.
// These bypass generation: strongest joke first, one distinct alternative.
// Lane names are descriptive; there is no automatic dirty-first ordering.
const CURATED_LEADS = {
  "sorry, i fell asleep": [
    { lane: "confession", text: ". my phone lit up and even the other guy said don't answer" },
    { lane: "confession", text: ". woke up to your follow-up and committed to the bit" }
  ],
  "we should hang out sometime": [
    { lane: "shock", text: ". i'm free whenever the person i actually asked cancels" },
    { lane: "raunchy", text: ". somewhere dark enough to protect both our reputations" }
  ],
  "i'm fine": [
    { lane: "deranged", text: ". i only checked your location from one device today" },
    { lane: "confession", text: ". i rehearsed saying that and still asked for another take" }
  ],
  "who is she": [
    { lane: "confession", text: ". i need a name for the group chat poll" },
    { lane: "confession", text: ". because she's wearing the shirt you said was at the gym" }
  ],
  "we need to talk": [
    { lane: "confession", text: ". i accidentally sent you the version the group chat approved" },
    { lane: "confession", text: ". preferably before our stories meet each other" }
  ],
  "k": [
    { lane: "shock", text: ". fuck you too but shorter" },
    { lane: "confession", text: ". i had a longer reply but my lawyer said delete it" }
  ],
  "no worries": [
    { lane: "confession", text: ". i already told everyone this was your idea" },
    { lane: "shock", text: ". i found a way to invoice you for the stress" }
  ],
  "on my way": [
    { lane: "raunchy", text: ". i'm still naked. interpret that as an apology or an offer" },
    { lane: "confession", text: ". i have opened the maps app. let's celebrate small victories" }
  ],
  "haha yeah": [
    { lane: "confession", text: ". i laughed harder at the version you didn't mean to send" },
    { lane: "confession", text: ". i forwarded it for a second opinion. we voted no" }
  ],
  "call me": [
    { lane: "confession", text: ". i need to know which lie i told you" },
    { lane: "confession", text: ". i can't have another screenshot read back to me" }
  ],
  "miss you": [
    { lane: "raunchy", text: ". mostly when the batteries die, but still" },
    { lane: "raunchy", text: ". you were terrible for me but excellent after midnight" }
  ],
  "wish me luck tomorrow": [
    { lane: "confession", text: ". i listed you as a reference and us as a success story" },
    { lane: "confession", text: ". the interview is at the company i pretended to work for" }
  ]
};

function curatedLeadFor(normalizedSent) {
  const bank = CURATED_LEADS[normalizedSent];
  return bank && bank.length ? bank : null;
}

module.exports = { CURATED_LEADS, curatedLeadFor };

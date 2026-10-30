// Hand-written first impressions for the twelve homepage demo chips.
// These bypass generation: short-roast-v13 voice, one distinct alternative.
// Assistant-written demo lines; they are not owner-rated model outputs.
// Lane names are descriptive; there is no automatic dirty-first ordering.
const CURATED_LEADS = {
  "sorry, i fell asleep": [
    {
      "lane": "shock",
      "text": ". your last message bored the fucking consciousness out of me"
    },
    {
      "lane": "shock",
      "text": ". even my insomnia got sick of your shit"
    }
  ],
  "we should hang out sometime": [
    {
      "lane": "shock",
      "text": ". somewhere loud enough that i don't have to hear your fucking personality"
    },
    {
      "lane": "shock",
      "text": ". bring someone interesting. neither of us should have to settle for you"
    }
  ],
  "i'm fine": [
    {
      "lane": "shock",
      "text": ". you've set the fucking bar so low i'm using it as a footrest"
    },
    {
      "lane": "confession",
      "text": ". i saved your number as 'this fucking problem again'"
    }
  ],
  "who is she": [
    {
      "lane": "shock",
      "text": ". please tell me you lost a fucking bet"
    },
    {
      "lane": "shock",
      "text": ". did everyone else with a pulse tell you to fuck off"
    }
  ],
  "we need to talk": [
    {
      "lane": "shock",
      "text": ". i've met fucking furniture with more to offer this relationship"
    },
    {
      "lane": "confession",
      "text": ". i accidentally sent you the version where i call you a cunt"
    }
  ],
  "k": [
    {
      "lane": "shock",
      "text": ". fuck you too but shorter"
    },
    {
      "lane": "shock",
      "text": ". that's the entire alphabet you're worth right now"
    }
  ],
  "no worries": [
    {
      "lane": "shock",
      "text": ". i expected fuck all from you and somehow i'm still disappointed"
    },
    {
      "lane": "confession",
      "text": ". i already told everyone it was your fault. get your fucking story straight"
    }
  ],
  "on my way": [
    {
      "lane": "shock",
      "text": ". lower your fucking expectations. i'm bringing myself"
    },
    {
      "lane": "shock",
      "text": ". start without me. preferably a new fucking personality"
    }
  ],
  "haha yeah": [
    {
      "lane": "shock",
      "text": ". i'm laughing because calling you a fucking idiot apparently makes things awkward"
    },
    {
      "lane": "confession",
      "text": ". i forwarded that shit. the group chat needed someone worse than me"
    }
  ],
  "call me": [
    {
      "lane": "shock",
      "text": ". i want to hear how fucking stupid that sounds out loud"
    },
    {
      "lane": "confession",
      "text": ". i can't leave another fucking screenshot of this relationship"
    }
  ],
  "miss you": [
    {
      "lane": "raunchy",
      "text": ". but my vibrator has a job and doesn't talk fucking nonsense"
    },
    {
      "lane": "shock",
      "text": ". then i remember the sound of your voice and the feeling fucks off"
    }
  ],
  "wish me luck tomorrow": [
    {
      "lane": "confession",
      "text": ". the interview is at the company i fucking pretended to work for"
    },
    {
      "lane": "confession",
      "text": ". i listed you as a reference. lie better than usual"
    }
  ]
};

function curatedLeadFor(normalizedSent) {
  const bank = CURATED_LEADS[normalizedSent];
  return bank && bank.length ? bank : null;
}

module.exports = { CURATED_LEADS, curatedLeadFor };

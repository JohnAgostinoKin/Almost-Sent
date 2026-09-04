const { norm } = require("./normalize");

// Fast-path for the three hero examples the page itself promises (the
// examples section in index.html, and the system prompt's own voice
// examples). Fires on an exact (normalized) match before the model is ever
// called — these three need to be deterministic like "k" is, not left to a
// temperature-1.0 model to maybe land on. Nothing else belongs in here;
// every other input goes to the model.
const BANK = {
  "k": "l",
  "sounds good": "what a load of crap",
  "made it home": "you live next door"
};

function exactMatch(sent) {
  const key = norm(sent);
  return Object.prototype.hasOwnProperty.call(BANK, key) ? BANK[key] : null;
}

module.exports = { BANK, exactMatch };

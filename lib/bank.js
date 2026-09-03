const { norm } = require("./normalize");

// Fast-path for the reflex texts everyone sends. Fires on an exact
// (normalized) match before the model is ever called. Every line here
// should be one you'd screenshot — if it reads soft, it doesn't belong.
//
// Deliberately kept small and reflex-only (single words / near-single
// words). Full sentences go to the model — that's the actual product.
const BANK = {
  "k": "l",
  "kk": "l, twice",
  "lmao": "i wasn't even smiling",
  "haha": "i didn't laugh",
  "nice": "that word again",
  "cool": "tell me something true",
  "bet": "we'll see about that",
  "np": "there's plenty",
  "yw": "didn't ask",
  "?": "use your words",
  "??": "still no",
  "omw": "in your own time, as always",
  "here": "finally",
  "outside": "so am i, alone",
  "nvm": "too late for that",
  "gn": "don't dream about it",
  "wyd": "guess",
  "hey": "that's the whole message",
  "yo": "heard you the first time",
  "sup": "nothing, same as you",
  "fine": "sure",
  "busy": "you always are",
  "later": "a word you use instead of no",
  "seen": "and still nothing"
};

function exactMatch(sent) {
  const key = norm(sent);
  return Object.prototype.hasOwnProperty.call(BANK, key) ? BANK[key] : null;
}

module.exports = { BANK, exactMatch };

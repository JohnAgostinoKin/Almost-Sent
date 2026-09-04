const { norm } = require("./normalize");

// Fast-path for the hero examples the page itself promises (the examples
// section in index.html, and the system prompt's own voice examples). Fires
// on an exact (normalized) match before the model is ever called — these
// need to be deterministic like the rest of the model's output isn't,
// temperature 1.0 being what it is. Nothing else belongs in here; every
// other input goes to the model.
//
// Every value here is a CONTINUATION and follows the same convention the
// model's own output does (see lib/postprocess.js's OPENER_RE / lib/
// compose.js's composeDraft): it opens with the punctuation or space that
// connects it to the sent text, and the page concatenates rather than
// replaces. "k" -> "l" is the one deliberate exception — the brand joke
// predates the continuation mechanic, so it's stored as a bare word with no
// leading connector on purpose. That absence is also the tell composeDraft
// uses to render it as a straight replacement instead of appending it, with
// no special-casing needed anywhere else in the codebase.
const BANK = {
  "k": "l",
  "sounds good": ". i already told your boss you're pregnant",
  "made it home": ". your mom drove. we're engaged.",
  "on my way": ". also i sold your car. it's fine. we'll talk."
};

function exactMatch(sent) {
  const key = norm(sent);
  return Object.prototype.hasOwnProperty.call(BANK, key) ? BANK[key] : null;
}

module.exports = { BANK, exactMatch };

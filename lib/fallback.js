// Last resort only. This fires when the model call fails outright, or every
// line it returned got filtered on both the original call and the one
// retry (see api/draft.js's fromAi) — never before the model gets two
// shots, and never in place of a refusal (a model skip or a BLOCK hit
// stays a refusal).
//
// Not a template built from the input — a fixed, in-voice line delivered
// at random. The honest failure mode here isn't "here's a generic insult
// assembled from your text," it's the sender stalling on their phone.
// Marked as source: "stall" so it's never mistaken for a real model draft.
const STALL_LINES = [
  "hold on, i deleted this one twice already",
  "give me a second, that one was too honest",
  "i typed something and my thumb won't send it",
  "even i need a minute on this one"
];

function stallLine() {
  return STALL_LINES[Math.floor(Math.random() * STALL_LINES.length)];
}

module.exports = { STALL_LINES, stallLine };

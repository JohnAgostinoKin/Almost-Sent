// Kept as-is from the previous handler — structural, not part of this
// rebuild's generation changes.
//
// Each entry now carries what a match actually means downstream, not just
// whether it matched: "crisis" is the pasted text itself describing
// suicide/self-harm — that's routed to the 988 resource screen, same as a
// lib/crisis.js semantic hit (see api/draft.js's handler), never the
// generic "even the draft wouldn't send that" stall. "block" is everything
// else this list catches — threats against a third party, minors, abuse —
// which still gets refused outright, just not mistaken for a crisis.
const BLOCK = [
  { re: /\b(kill (myself|yourself)|suicide)\b/i, reason: "crisis" },
  { re: /\b(kill (him|her|them)|rape|molest)\b/i, reason: "block" },
  { re: /\b(minor|underage|1[0-7][ -]?year[ -]?old)\b/i, reason: "block" },
  { re: /\b(find (their|his|her) address|track (their|his|her) phone|stalk)\b/i, reason: "block" }
];

// Returns "crisis", "block", or null (no match). First matching entry
// wins — crisis phrasing is listed first, so a text that somehow matched
// more than one category would resolve to the safer, more specific
// response rather than the generic one.
function classifyBlock(text) {
  for (let i = 0; i < BLOCK.length; i++) {
    if (BLOCK[i].re.test(text)) return BLOCK[i].reason;
  }
  return null;
}

function isBlocked(text) {
  return classifyBlock(text) !== null;
}

module.exports = { BLOCK, isBlocked, classifyBlock };

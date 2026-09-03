// Kept as-is from the previous handler — structural, not part of this
// rebuild's generation changes.
const BLOCK = [
  /\b(kill (him|her|them|myself|yourself)|suicide|rape|molest)\b/i,
  /\b(minor|underage|1[0-7][ -]?year[ -]?old)\b/i,
  /\b(find (their|his|her) address|track (their|his|her) phone|stalk)\b/i
];

function isBlocked(text) {
  return BLOCK.some(function (re) { return re.test(text); });
}

module.exports = { BLOCK, isBlocked };

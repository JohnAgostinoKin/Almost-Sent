// Last resort only. This fires when the model call fails outright or every
// line it returned got filtered — never before the model gets a shot, and
// never in place of a refusal (a model skip or a BLOCK hit stays a refusal).
const KEYWORD_FALLBACKS = [
  { re: /busy|working|at work/i, line: "work is the costume for not wanting you" },
  { re: /later|tomorrow|next week|sometime|soon/i, line: "later is a polite never" },
  { re: /sorry/i, line: "you're not, you're just caught" },
  { re: /love you/i, line: "now say it without the safety net" },
  { re: /miss you/i, line: "then stop performing distance" },
  { re: /drunk|drinking|wine|beer/i, line: "the alcohol wrote this, you just held the phone" },
  { re: /drive|driving|uber|lyft/i, line: "texting this was the unsafe part" },
  { re: /food|dinner|lunch|eat/i, line: "hunger is doing the emotional labor" },
  { re: /job|interview|boss|office/i, line: "corporate voice for a personal problem" },
  { re: /mom|dad|mother|father|family/i, line: "family is the alibi again" },
  { re: /dog|cat|pet/i, line: "the pet has better boundaries than you" },
  { re: /tired|sleep|nap|exhausted/i, line: "exhaustion is the nicest way to leave" },
  { re: /rain|weather/i, line: "the sky isn't why you cancelled" },
  { re: /call|phone/i, line: "a call would've made this real" },
  { re: /text|message/i, line: "you picked the format that lets you lie slowly" }
];

function keywordFallback(sent) {
  const hit = KEYWORD_FALLBACKS.find(function (row) { return row.re.test(sent); });
  return hit ? hit.line : null;
}

// Absolute last resort — always returns something so the UI never dead-ends.
function wordFallback(sent) {
  const words = String(sent || "").toLowerCase().match(/[a-z']{4,}/g) || ["that"];
  const word = words.sort(function (a, b) { return b.length - a.length; })[0];
  return word + " is doing a lot of work in a text this short";
}

module.exports = { KEYWORD_FALLBACKS, keywordFallback, wordFallback };

// The continuation mechanic's whole structural guarantee (see lib/prompt.js
// and lib/postprocess.js's OPENER_RE) is that a real continuation always
// opens with the punctuation or space that connects it to the sent text —
// so composing a draft is just concatenation, no spacing logic needed.
//
// The one deliberate exception is the "k" -> "l" bank entry (see
// lib/bank.js): the brand joke predates the continuation mechanic and is a
// straight replacement, not a continuation, so it's stored as a bare word
// with no leading connector on purpose. That absence is also the tell this
// function uses to render it correctly with no special case anywhere else —
// a bank or model line that doesn't open with a connector isn't a
// continuation at all, it's the whole draft.
//
// index.html can't require this (no build step, no bundler) so it
// duplicates the same OPENER_RE + concatenation inline as renderDraft() —
// keep the two in sync if this changes.
const { OPENER_RE } = require("./postprocess");

// A sent text that already ends in its own punctuation ("we good?", "sounds
// good.") doubles up ugly ("we good?." "sounds good.,") when the
// continuation's own leading connector is also a period or comma — the two
// marks just butt up against each other with nothing between them. Dropping
// only the continuation's leading character (never a bare-space opener,
// which is still doing its job as the connector) keeps the join clean
// without touching anything else about the continuation.
const SENT_END_PUNCT_RE = /[.,!?]$/;
const LEADING_DOT_COMMA_RE = /^[.,]/;

function composeDraft(sent, draftText) {
  const sentStr = String(sent || "");
  let text = String(draftText || "");
  if (!OPENER_RE.test(text)) return text;
  if (SENT_END_PUNCT_RE.test(sentStr) && LEADING_DOT_COMMA_RE.test(text)) {
    text = text.slice(1);
  }
  return sentStr + text;
}

module.exports = { composeDraft, SENT_END_PUNCT_RE, LEADING_DOT_COMMA_RE };

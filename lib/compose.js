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

function composeDraft(sent, draftText) {
  const text = String(draftText || "");
  return OPENER_RE.test(text) ? String(sent || "") + text : text;
}

module.exports = { composeDraft };

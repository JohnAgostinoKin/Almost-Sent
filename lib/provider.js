// lib/provider.js
//
// OpenRouter serves openai/* models through more than one upstream —
// seen concretely across real calls this session: gpt-5.6-sol routed to
// Azure once, gpt-5.4-nano and gpt-5.4 to OpenAI directly on others.
// Azure's hosted OpenAI has been the slower of the two in practice for
// the same model id, so any openai/* model gets an explicit preference
// for OpenAI first, Azure second — still falls through to whatever else
// is available if both are unhealthy (this is a preference via `order`,
// not an exclusion list; OpenRouter's default allow_fallbacks behavior
// is untouched).
//
// Anything else (hermes, mistral) keeps the plain throughput-sort
// behavior it already had — an explicit order naming providers that
// don't actually serve a non-OpenAI model would be meaningless at best,
// and risks OpenRouter finding no matching provider at all if taken
// literally.
const OPENAI_RE = /^openai\//i;

function providerFor(model) {
  return OPENAI_RE.test(model || "")
    ? { order: ["OpenAI", "Azure"] }
    : { sort: "throughput" };
}

module.exports = { providerFor, OPENAI_RE };

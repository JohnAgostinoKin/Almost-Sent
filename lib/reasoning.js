// lib/reasoning.js
//
// gpt-5.x models accept a `reasoning: { effort: ... }` request field.
// Left unset, Sol (openai/gpt-5.6-sol) burns enough reasoning tokens to
// blow past every timeout in this app — seen concretely in production:
// 15.9s as the primary generator, 9.2s as the taste judge, both timing
// out, versus gpt-5.4 (no override, same call shape) finishing the
// generator job in 3.9s. "minimal" is the fix: turn reasoning down as far
// as it goes rather than trying to out-wait it with a longer timeout.
//
// Every request builder that might target a gpt-5.x model — primary/
// wildcard generation (lib/prompt.js), the taste and safety judges
// (lib/judge.js), the crisis classifier (lib/crisis.js) — merges this in
// conditionally. A non-gpt-5 model (hermes, mistral) gets nothing extra;
// the field means nothing to them and isn't worth sending.
const GPT5_RE = /^openai\/gpt-5\./i;

function reasoningOverride(model) {
  return GPT5_RE.test(model || "") ? { reasoning: { effort: "minimal" } } : {};
}

module.exports = { reasoningOverride, GPT5_RE };

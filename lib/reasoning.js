// lib/reasoning.js
//
// gpt-5.x models accept a `reasoning: { effort: ... }` request field.
// Left unset entirely, Sol (openai/gpt-5.6-sol) burns enough reasoning
// tokens to blow past every timeout in this app — seen concretely in
// production: 15.9s as the primary generator, 9.2s as the taste judge,
// both timing out, versus gpt-5.4 (no override, same call shape)
// finishing the generator job in 3.9s. reasoning:{effort:"minimal"} is
// the fix — but ONLY for a call with a generous max_tokens budget (the
// primary/wildcard generator calls, 400-1200 tokens). Confirmed with real
// calls on BOTH gpt-5.4-nano (the safety judge) and gpt-5.4 itself (the
// taste judge, in its compact-output form) that at a SMALL max_tokens
// (16-300, all a short structured answer actually needs) the override
// makes things WORSE, not better: the model still spends reasoning
// tokens under "minimal", just as many as its max_tokens allows, and
// never gets to the actual answer — content:null, finish_reason:"length",
// 100% of the completion budget spent on reasoning_tokens, reproduced
// at 16, 64, 300, and 500. Dropping the field entirely (not "minimal",
// NO reasoning field at all) is what makes those calls fast AND correct:
// reasoning_tokens:0, real content, sub-2s. So this override belongs on
// generation calls only — see lib/prompt.js's buildPrimaryRequest/
// buildWildcardRequest, the only callers — and deliberately NOT on any of
// lib/judge.js's or lib/crisis.js's short-answer request builders,
// regardless of which model any of them target.
const GPT5_RE = /^openai\/gpt-5\./i;

function reasoningOverride(model) {
  return GPT5_RE.test(model || "") ? { reasoning: { effort: "minimal" } } : {};
}

module.exports = { reasoningOverride, GPT5_RE };

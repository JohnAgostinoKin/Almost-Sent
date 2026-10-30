#!/usr/bin/env node
// Exercise the real HTTP handler, including selection, retries and pairwise.
// Model runs require a development LLM_API_KEY. Demo mode never calls a model.
// Both produce the existing bake-rate.html / bake-tally.js format.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
function value(flag, fallback) {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : args[at + 1];
}
const outputRoot = path.resolve(__dirname, '..');
const root = path.resolve(value('--repo', outputRoot));
const system = value('--system', 'AFTER');
const review = value('--review', '');
const demo = args.includes('--demo');
const limit = Number(value('--limit', '20'));
if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(system) ||
    (review && !/^[a-z0-9-]{1,40}$/.test(review)) ||
    !Number.isInteger(limit) || limit < 1 || limit > 20) {
  console.error('Use --system BEFORE|AFTER, --limit 1..20, and an optional alphanumeric --review name.');
  process.exit(1);
}
if (!demo && !process.env.LLM_API_KEY) {
  console.error('Live comedy comparison needs a development LLM_API_KEY. No results generated. Use --demo only for the fixed demo jokes.');
  process.exit(1);
}

// Synthetic evaluation must not log inbox entries, read user-rated hits,
// or reuse persisted production jokes, even if the caller loaded DB vars.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
if (demo) delete process.env.LLM_API_KEY;
const handler = require(path.join(root, 'api/draft'));
const { CURATED_LEADS } = require(path.join(root, 'lib/curated'));
const { composeDraft } = require(path.join(root, 'lib/compose'));
const { WILDCARD_MODEL, normalizeBefore } = require(path.join(root, 'lib/prompt'));
const corpusPath = path.resolve(outputRoot, value('--inputs', 'bake/comedy-inputs-v10.json'));
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const inputs = (demo ? Object.keys(CURATED_LEADS) : corpus.map(row => row.sent)).slice(0, limit);
if (!demo && inputs.some(sent => CURATED_LEADS[normalizeBefore(sent)])) {
  throw new Error('Model corpus contains a curated shortcut; use an unseen input.');
}
const dir = path.join(outputRoot, 'bake', review ? 'reviews/' + review : 'results');
fs.mkdirSync(dir, { recursive: true });
const output = path.join(dir, system + '.json');
const results = [];
const snapshot = {
  system, label: demo ? 'Fixed demo jokes; not a model evaluation' : 'Full first-reveal pipeline',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  model: demo ? null : WILDCARD_MODEL,
  generatedAt: new Date().toISOString(), results
};

async function main() {
  for (const [i, input] of inputs.entries()) {
    let code = 200, body;
    const res = { setHeader() {}, status(v) { code = v; return this; }, json(v) { body = v; return this; }, end() {} };
    const started = Date.now();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': 'comedy-evaluation' }, body: { sent: input } }, res);
    const valid = code === 200 && body && body.source === (demo ? 'curated' : 'model') &&
      Array.isArray(body.drafts) && body.drafts.length;
    // Rate first reveals only. Keeping every failed case in the denominator
    // prevents a strict judge's stalls from making the win rate look better.
    results.push({
      input, top3: valid ? [{ tag: body.drafts[0].lane, text: composeDraft(input, body.drafts[0].text) }] : [],
      source: body && body.source, weakLead: Boolean(body && body.weak_lead),
      elapsedMs: Date.now() - started, note: valid ? '' : (body && (body.stall_reason || body.error) || 'no reveal'),
      why: demo ? undefined : body && body.why
    });
    fs.writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`${i + 1}/${inputs.length}: ${valid ? 'reveal' : 'failed'} (${system})`);
  }
  console.log('Wrote ' + path.relative(outputRoot, output));
  console.log('These are outputs to rate, not evidence of a comedy win.');
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });

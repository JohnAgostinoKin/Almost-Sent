const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the complete handler with deterministic provider boundaries.
// No provider or database request can leave this process.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.LLM_API_KEY = 'synthetic-test-key';
const lines = {
  shock: '. the receipt has my name and your excuse on it',
  raunchy: '. bring condoms and a more convincing alibi',
  confession: '. the waiter recognized your other date',
  deranged: '. seven rehearsals and that was my casual voice',
  gross: '. the bathroom light gave up before i did'
};
let calls = 0;
let judged = [];
require('../lib/llm').callLLM = async function (key, model, sent, opts) {
  calls++;
  // Include an additional raunchy candidate to exercise deduplication.
  const lanes = opts.lanes.concat('raunchy');
  return { text: JSON.stringify({ candidates: lanes.map(lane => ({ lane, anchor: sent.split(' ')[0], text: lines[lane] })) }), latencyMs: 1 };
};
require('../lib/crisis').checkCrisis = async () => ({ crisis: false, state: 'clear' });
const judge = require('../lib/judge');
judge.judgeOneLine = async () => ({ verdict: false, latencyMs: 1, model: 'test' });
judge.judgeCandidates = async function (key, sent, candidates) {
  judged = candidates;
  const ranked = candidates.filter(c => c.lane === 'shock' || c.lane === 'raunchy')
    .map(candidate => ({ candidate, q: candidate.lane === 'shock' ? 15 : 14, reaction: candidate.lane === 'shock' ? 8 : 7 }))
    .sort((a, b) => b.q - a.q);
  return { ok: true, ranked, details: ranked.map(r => ({ ...r, lane: r.candidate.lane, eliminated: false })), model: 'test', latencyMs: 1 };
};
judge.judgePairwise = async () => ({ winner: 1, latencyMs: 1 });
const handler = require('../api/draft');

async function request(sent) {
  let status, body;
  const res = { setHeader() {}, status(v) { status = v; return this; }, json(v) { body = v; } };
  calls = 0;
  await handler({ method: 'POST', headers: { 'x-forwarded-for': 'generation-test' }, body: { sent } }, res);
  assert.equal(status, 200);
  assert.equal(body.source, 'model');
  return body;
}

test('full generation retains the chosen lead and does not spend another round filling weak alternates', async () => {
  const body = await request('come over after the rehearsal');
  assert.ok(judged.some(c => c.lane === 'raunchy'));
  assert.equal(body.drafts[0].text, lines.shock);
  assert.equal(body.drafts.length, 1);
  assert.equal(calls, 2);
});

test('full generation sends raunchy candidates to judging without invitation keywords', async () => {
  const body = await request('your proposal has seven appendices');
  assert.ok(judged.length);
  assert.ok(judged.some(c => c.lane === 'raunchy'));
  assert.equal(body.drafts[0].text, lines.shock);
  assert.equal(calls, 2);
});


test('the experimental live-demo setting makes homepage chips exercise the writer', async () => {
  process.env.LIVE_DEMOS = '1';
  try {
    const body = await request('k');
    assert.equal(body.drafts[0].text, lines.shock);
    assert.equal(calls, 2);
  } finally { delete process.env.LIVE_DEMOS; }
});

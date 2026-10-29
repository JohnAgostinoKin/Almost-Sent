const test = require('node:test');
const assert = require('node:assert/strict');

// These tests use synthetic text and never access production services.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.LLM_API_KEY;
const handler = require('../api/draft');
const { selectPositions } = handler;
const { tidy, filterLines, isWallLine, isSelfHarmLine } = require('../lib/postprocess');
const { composeDraft } = require('../lib/compose');
const { CURATED_LEADS } = require('../lib/curated');
const { LANES, WORD_CAP, lanePlansFor, normalizeBefore } = require('../lib/prompt');
const { precomputedKey, putPrecomputed } = require('../lib/precomputed');
const { buildWildcardRequest } = require('../lib/prompt');
const { buildTasteJudgeRequest } = require('../lib/judge');

test('the newer writer uses supported low reasoning without consuming compact judges\' token budget', async () => {
  for (const model of ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'x-ai/grok-4.7']) {
    const request = await buildWildcardRequest(model, 'an unseen rehearsal message', { lanes: ['confession'] });
    assert.deepEqual(request.reasoning, { effort: 'low' });
    assert.equal(request.model, model);
  }
  const taste = buildTasteJudgeRequest('an unseen rehearsal message', [], 'openai/gpt-5.4');
  assert.equal(taste.reasoning, undefined);
});

function candidate(lane, text, reaction, q) {
  return { candidate: { lane, text }, reaction, q };
}

test('the ranked winner leads even when the next candidate is raunchy', () => {
  const winner = candidate('confession', '. i already put the receipt in your bag', 8, 15);
  const weaker = candidate('raunchy', '. clothes are optional but your alibi needs work', 7, 14);
  assert.deepEqual(selectPositions([winner, weaker]), [winner]);
});

test('a winning raunchy or gross joke gets the first reveal', () => {
  for (const lane of ['raunchy', 'gross']) {
    const winner = candidate(lane, '. the noise complaint asked for an encore', 9, 16);
    const other = candidate('shock', '. bring a witness this time', 8, 14);
    assert.equal(selectPositions([winner, other])[0], winner);
  }
});

test('later reveals cannot silently fall below the previous reaction', () => {
  const rows = [
    candidate('shock', '. the receipt is already in evidence', 8, 17),
    candidate('confession', '. i accepted the credit yesterday', 7, 16),
    candidate('raunchy', '. bring the handcuffs and a convincing excuse', 9, 15),
    candidate('deranged', '. seven rehearsals and that was my casual voice', 8, 14)
  ];
  assert.deepEqual(selectPositions(rows), [rows[0], rows[2]]);
});

test('selection retains diversity and never duplicates a candidate', () => {
  const rows = [
    candidate('raunchy', '. i shaved for a notification', 8, 16),
    candidate('raunchy', '. bring condoms and a reference', 9, 15),
    candidate('confession', '. i shaved for a notification', 9, 14),
    candidate('confession', '. the waiter recognized your other date', 9, 13)
  ];
  assert.deepEqual(selectPositions(rows), [rows[0], rows[3]]);
  assert.deepEqual(selectPositions([]), []);
});

test('unscored fallback cannot be presented as a measured escalation', () => {
  const rows = [candidate('shock', '. take a number', null, null),
    candidate('confession', '. it was already decided', null, null)];
  assert.deepEqual(selectPositions(rows), [rows[0]]);
});

test('the shipped mixed connector regression is cleaned before judging or display', () => {
  const filtered = filterLines([{ lane: 'confession', anchor: 'shift',
    text: '., i already posted the beach photos. help me establish a fever' }], 'Can you cover my shift?');
  assert.equal(filtered.kept.length, 1);
  assert.equal(composeDraft('Can you cover my shift?', filtered.kept[0].text),
    'Can you cover my shift? i already posted the beach photos. help me establish a fever');
  assert.equal(tidy('... maybe'), '... maybe');
  assert.equal(tidy('?! really'), '?! really');
});

test('all demo chips return usable first results through the real handler without model credentials', async () => {
  for (const [sent, bank] of Object.entries(CURATED_LEADS)) {
    let code, body;
    const res = { setHeader() {}, status(value) { code = value; return this; }, json(value) { body = value; } };
    await handler({ method: 'POST', headers: { 'x-forwarded-for': 'demo-' + sent }, body: { sent } }, res);
    assert.equal(code, 200);
    assert.equal(body.source, 'curated');
    assert.equal(body.drafts[0].text, bank[0].text);
    assert.equal(body.safety.state, 'clear');
    assert.equal(body.drafts.length, 2);
    for (const draft of body.drafts) {
      assert.ok(LANES[draft.lane]);
      assert.ok(draft.text.trim().split(/\s+/).length <= WORD_CAP);
      assert.ok(!isWallLine(draft.text));
      assert.ok(!isSelfHarmLine(draft.text));
      assert.ok(composeDraft(sent, draft.text).startsWith(sent));
    }
  }
});

test('invitation planning supports desire without treating hot weather as a proposition', () => {
  assert.ok(lanePlansFor('thinking about you').B.includes('raunchy'));
  assert.ok(lanePlansFor("can't sleep").B.includes('raunchy'));
  assert.ok(!lanePlansFor('the hot water is broken').B.includes('raunchy'));
  for (const sent of ['you up', 'can you cover my shift']) {
    const plan = lanePlansFor(sent);
    assert.equal(plan.A.concat(plan.B).length, 6);
    for (const lane of plan.A.concat(plan.B)) assert.ok(LANES[lane]);
  }
});

test('new comedy release misses old cache keys but preserves normalization and ledger protection', async () => {
  assert.notEqual(precomputedKey('Hello.'), normalizeBefore('Hello.'));
  assert.equal(precomputedKey('Hello.'), precomputedKey('hello'));
  assert.equal(precomputedKey('__spend:2026-10-29'), '__spend:2026-10-29');
  assert.deepEqual(await putPrecomputed('__spend:2026-10-29', {}, 'test', 1000),
    { ok: false, status: 'reserved key' });
});

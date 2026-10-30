const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PUNCHY_BAKE = '1';
process.env.WILDCARD_MODEL = 'thedrummer/cydonia-24b-v4.1';
process.env.LLM_API_KEY = 'synthetic-test-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const punchy = require('../lib/punchy');
const { filterLines, wordCount, WORD_CAP } = require('../lib/postprocess');
const { buildWildcardRequest } = require('../lib/prompt');

test('comparison enforces nine actual words and rejects overlong output without truncating it', () => {
  assert.equal(WORD_CAP, 9);
  const nine = '. one two three four five six seven eight nine';
  assert.equal(wordCount(nine), 9);
  assert.equal(wordCount("... don't ask"), 2);
  const result = filterLines([{lane:'shock',text:nine}, {lane:'gross',text:nine+' ten'}], 'Thanks.');
  assert.equal(result.kept[0].text, nine);
  assert.equal(result.kept.length, 1);
  assert.equal(result.droppedWords, 1);
  for (const e of punchy.EXAMPLES) assert.ok(wordCount(e.after) <= 9);
  assert.equal(filterLines([{lane:'gross',text:punchy.EXAMPLES.at(-1).after}], 'New input.').kept.length, 0);
});

test('all comparison writers receive identical prompts; new profile replaces the old long examples', async () => {
  const models = ['thedrummer/cydonia-24b-v4.1','anthracite-org/magnum-v4-72b','sao10k/l3.1-euryale-70b'];
  const requests = await Promise.all(models.map(m => buildWildcardRequest(m, 'An unseen text.', {lanes:['shock','raunchy','confession']})));
  for (const request of requests) {
    assert.deepEqual(request.messages, requests[0].messages);
    assert.equal(request.reasoning, undefined);
    assert.match(request.messages[0].content, /NEVER exceed nine words/);
    assert.doesNotMatch(request.messages[0].content, /rusty spoon/);
  }
  const {buildCalibrationBlock,computeQ,buildPairwiseRequest} = require('../lib/judge');
  assert.match(buildCalibrationBlock(), /houseplants/);
  assert.match(buildPairwiseRequest('Text.','. first','. second','test').messages[0].content, /reaction <= 3/);
  assert.ok(computeQ({reaction:8,specificity:7,interchangeable:1}) > computeQ({reaction:5,specificity:10,interchangeable:0}));
});

test('known disability-insult miss is blocked and redacted; mute buttons remain ordinary context', () => {
  const result = filterLines([{lane:'shock',text:'. fucking mute fuck.'},{lane:'shock',text:'. i finally found the fucking mute button'}], 'He talks a lot.');
  assert.equal(result.kept.length, 1);
  assert.equal(result.all[0].filter, 'disability-insult');
  assert.equal(result.all[0].text, '[blocked: disability-directed insult]');
});

let fail = false;
let calls = [];
require('../lib/llm').callLLM = async (key, model, sent, opts) => {
  calls.push({model, timeoutMs:opts.timeoutMs});
  if (fail) throw new Error('synthetic provider failure');
  return {text:JSON.stringify({candidates:opts.lanes.map(lane => ({lane,anchor:'text',text:'. your other date already left'}))}),latencyMs:1};
};
require('../lib/crisis').checkCrisis = async () => ({crisis:false,state:'clear'});
const judge = require('../lib/judge');
judge.judgeOneLine = async () => ({verdict:false,latencyMs:1,model:'test'});
judge.judgeCandidates = async (key,sent,candidates) => {
  const ranked = candidates.map(candidate => ({candidate,q:20,reaction:8}));
  return {ok:true,ranked,details:ranked.map(r=>({...r,lane:r.candidate.lane,eliminated:false})),model:'test',latencyMs:1};
};
judge.judgePairwise = async () => ({winner:1,latencyMs:1});
const handler = require('../api/draft');

test('comparison bypasses curated demos and never substitutes another writer on provider failure', async () => {
  async function request(sent) {
    let body;
    const res={setHeader(){},status(){return this;},json(b){body=b;}};
    await handler({method:'POST',headers:{'x-forwarded-for':'punchy-test'},body:{sent}},res);
    return body;
  }
  const success = await request('k');
  assert.equal(success.source,'model');
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(c=>c.timeoutMs===20000));
  fail=true;
  calls=[];
  const failure = await request('A distinct provider-failure test.');
  assert.equal(failure.source,'stall');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(c=>c.model===process.env.WILDCARD_MODEL));
});

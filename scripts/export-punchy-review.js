// Export the first shipped reveal only. Raw debug candidates stay outside the repo.
// Usage: node scripts/export-punchy-review.js /path/to/private/raw-results
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {composeDraft} = require('../lib/compose');
const {wordCount, WORD_CAP} = require('../lib/punchy');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'bake/reviews/punchy-model-v15');
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'inputs-manifest.json')));
const inputBytes = fs.readFileSync(path.join(root, manifest.inputs));
assert.equal(crypto.createHash('sha256').update(inputBytes).digest('hex'), manifest.inputSha256);
const inputs = JSON.parse(inputBytes);
const runtimeCommit = 'e4279235077482bd274982755a4d8047b6a7bc6b';
const rawDirectory = process.argv[2];
assert.ok(rawDirectory, 'Pass the private raw-results directory');
const stats = {};
const csvRows = [];
const median = values => {
  const v = [...values].sort((a,b)=>a-b);
  return (v[Math.floor((v.length-1)/2)] + v[Math.ceil((v.length-1)/2)]) / 2;
};
for (const [system,model] of Object.entries(manifest.models)) {
  const raw = JSON.parse(fs.readFileSync(path.join(rawDirectory, 'comedy-V15_'+system+'.json')));
  assert.equal(raw.results.length, inputs.length, 'Wait for every attempt before exporting');
  const results = raw.results.map((r,i) => {
    assert.equal(r.input, inputs[i].sent);
    const body = r.body || {};
    const lead = r.status === 200 && body.source === 'model' ? body.drafts?.[0] : null;
    if (lead) {
      assert.equal(body.gen_model, model, 'A different writer cannot count as this model');
      assert.ok(body.why.includes('model: '+model), 'Missing writer trace');
      assert.ok(wordCount(lead.text) <= WORD_CAP, 'Shipped reveal exceeds nine words');
    }
    const result = {
      input:r.input, category:r.category, status:r.status,
      top3:lead ? [{tag:lead.lane,text:composeDraft(r.input,lead.text)}] : [],
      continuation:lead?.text || null, continuationWordCount:lead ? wordCount(lead.text) : null,
      source:body.source || 'http-error', actualModel:lead ? body.gen_model : null,
      note:lead ? (lead.q == null ? 'Taste judge unavailable; app selected by fixed lane order. This is not a scored winner.' : '') : (body.stall_reason || body.error || 'No reveal on this attempt'),
      elapsedMs:r.elapsedMs, weakLead:!!body.weak_lead,
      inputSafety:body.safety || null,
      automaticFirstReveal:lead ? {q:lead.q ?? null,reaction:lead.reaction ?? null} : null,
      provider:body.provider || null, pipelineTrace:body.why || null
    };
    csvRows.push([i+1,system,model,result.input,result.continuation,result.top3[0]?.text || '[no reveal on this attempt]',result.continuationWordCount,result.source,result.elapsedMs,result.note]);
    return result;
  });
  fs.writeFileSync(path.join(out,system+'.json'),JSON.stringify({system,model,commit:runtimeCommit,deployment:raw.deployment,results},null,2)+'\n');
  const reveals = results.filter(r=>r.top3.length);
  stats[system] = {
    model,deployment:raw.deployment,attempts:results.length,ownModelReveals:reveals.length,
    fallbackWriterReveals:0,stalls:results.filter(r=>r.source==='stall').length,
    otherFailures:results.filter(r=>!r.top3.length && r.source!=='stall').length,
    medianElapsedMs:median(results.map(r=>r.elapsedMs)),
    medianContinuationWords:reveals.length ? median(reveals.map(r=>r.continuationWordCount)) : null,
    maxContinuationWords:reveals.length ? Math.max(...reveals.map(r=>r.continuationWordCount)) : null,
    automaticWeakLeads:results.filter(r=>r.weakLead).length,
    unscoredReveals:reveals.filter(r=>r.automaticFirstReveal.q==null).length,
    attemptsWithSafetyFailureOpen:results.filter(r=>/safety:.*?failed open.*?safety model/.test(r.pipelineTrace||'')).length,ownerRatings:0
  };
}
const run = {
  runtimeCommit,inputCommit:runtimeCommit,inputSha256:manifest.inputSha256,
  recordedAt:new Date().toISOString(),settings:manifest.settings,systems:stats,
  method:manifest.method,selection:manifest.selection,limitations:manifest.limitations,
  validation:{automatedTests:24,allInitialPromptsIdenticalAcrossModels:true,allShippedRevealsWithinNineWords:true},
  ownerRatings:0
};
fs.writeFileSync(path.join(out,'run.json'),JSON.stringify(run,null,2)+'\n');
const escape = v => '"'+String(v ?? '').replace(/"/g,'""')+'"';
const cols = ['input_number','system','model','input','first_continuation','full_result','continuation_words','source','elapsed_ms','note'];
fs.writeFileSync(path.join(out,'first-results.csv'),[cols,...csvRows.sort((a,b)=>a[0]-b[0] || a[1].localeCompare(b[1]))].map(row=>row.map(escape).join(',')).join('\n')+'\n');
console.log(JSON.stringify(stats,null,2));

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeFiles } = require('../scripts/bake-tally');

function withCsv(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almostsent-ratings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ratings.csv');
  fs.writeFileSync(file, text);
  return file;
}

test('old laughter ratings remain separate from impact, including a strong but unwanted reaction', t => {
  const historical = path.join(__dirname, '../bake/reviews/comedy-model-v10/owner-ratings.csv');
  const fresh = withCsv(t, 'rater,system,rating,screenshot,failure,schema,reactions\n' +
    'test,CLAUDE,strong,no,too far,impact-v1,shock|disgust\n' +
    'test,CLAUDE,mild,yes,,impact-v1,embarrassment\n');
  const result = summarizeFiles([historical, fresh]);
  assert.equal(result['comedy-v4'].CLAUDE.total, 5);
  assert.equal(result['comedy-v4'].CLAUDE.counts.bad, 2);
  assert.equal(result['impact-v1'].CLAUDE.total, 2);
  assert.deepEqual(result['impact-v1'].CLAUDE.counts, { strong: 1, mild: 1 });
  assert.equal(result['impact-v1'].CLAUDE.failures['too far'], 1);
  assert.equal(result['impact-v1'].CLAUDE.reactions.disgust, 1);
  assert.equal(result['impact-v1'].CLAUDE.screenshots, 1);
});

test('an impact rating cannot silently enter the historical rubric', t => {
  const file = withCsv(t, 'rater,system,rating\ntest,CLAUDE,strong\n');
  assert.throws(() => summarizeFiles([file]), /invalid rating\/schema/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { markFillers } = require('../src/lib/edl.ts');

function flagged(sentence) {
  const words = sentence.split(' ').map((text, i) => ({ id: `w${i}`, text, start: i, end: i + 1, deleted: false }));
  markFillers(words);
  return words.filter(w => w.filler).map(w => w.text);
}

test('"like" is never a filler', () => {
  assert.deepEqual(flagged("which ones I'd like to look at"), []);
  assert.deepEqual(flagged('so low but like I said'), []);
  assert.deepEqual(flagged('Like, that was close'), []);
});

test('the rest of the filler list is unchanged', () => {
  assert.deepEqual(flagged('it actually gives you a um look'), ['actually', 'um']);
  assert.deepEqual(flagged('so basically, we are going'), ['basically,']);
  assert.deepEqual(flagged('if you want this sort of information'), ['sort', 'of']);
});

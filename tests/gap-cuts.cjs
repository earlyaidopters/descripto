const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { gapCuts, deriveCuts } = require('../src/lib/edl.ts');
const { findSpeechRuns } = require('../src/lib/audio-envelope.ts');

const RATE = 16000;
const pcmOf = segments => {
  const out = [];
  for (const [sec, amp] of segments) for (let i = 0; i < Math.round(sec * RATE); i++) out.push(Math.round(amp * Math.sin((2 * Math.PI * 220 * out.length) / RATE)));
  return { sampleRate: RATE, samples: Int16Array.from(out) };
};
const LOUD = 0.3 * 32767; // about -13.5 dBFS, well above -35
const BREATH = 32768 * 10 ** (-42 / 20) * Math.SQRT2; // -42 dBFS: audible, below the -35 speech floor
const on = { enabled: true, minGap: 1.0, margin: 0.25 };
const word = (id, start, end, deleted = false) => ({ id, text: id, start, end, deleted });
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

test('findSpeechRuns: sustained loud audio is a run; a breath at -42 dBFS is not', () => {
  // loud 0-1, silence 1-2, breath 2-2.5, silence 2.5-3, loud 3-4
  const pcm = pcmOf([[1, LOUD], [1, 0], [0.5, BREATH], [0.5, 0], [1, LOUD]]);
  const runs = findSpeechRuns(pcm);
  assert.equal(runs.length, 2, JSON.stringify(runs));
  assert.ok(near(runs[0].start, 0) && near(runs[0].end, 1), JSON.stringify(runs[0]));
  assert.ok(near(runs[1].start, 3) && near(runs[1].end, 4), JSON.stringify(runs[1]));
});

test('findSpeechRuns: a loud blip under the 200 ms hold is not a run', () => {
  const pcm = pcmOf([[1, LOUD], [1, 0], [0.15, LOUD], [1, 0], [1, LOUD]]);
  const runs = findSpeechRuns(pcm);
  assert.equal(runs.length, 2, JSON.stringify(runs));
});

test('gapCuts: a breathy gap between kept words is cut whole, minus margins', () => {
  // words at 0-1 and 11-12; speech runs only inside the words
  const words = [word('a', 0, 1), word('b', 11, 12)];
  const speech = [{ start: 0, end: 1 }, { start: 11, end: 12 }];
  const cuts = gapCuts(words, speech, on, 12);
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.ok(near(cuts[0].start, 1.25) && near(cuts[0].end, 10.75), JSON.stringify(cuts[0]));
});

test('gapCuts: a sustained speech run inside the gap (transcription hole) vetoes it', () => {
  const words = [word('a', 0, 1), word('b', 11, 12)];
  const speech = [{ start: 0, end: 1 }, { start: 5, end: 5.6 }, { start: 11, end: 12 }];
  assert.equal(gapCuts(words, speech, on, 12).length, 0);
});

test('gapCuts: a speech run covered by a deleted word does not veto the gap', () => {
  // a deleted false-start at 5-5.6 accounts for the loud run there
  const words = [word('a', 0, 1), word('x', 5, 5.6, true), word('b', 11, 12)];
  const speech = [{ start: 0, end: 1 }, { start: 5, end: 5.6 }, { start: 11, end: 12 }];
  const cuts = gapCuts(words, speech, on, 12);
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.ok(near(cuts[0].start, 1.25) && near(cuts[0].end, 10.75), JSON.stringify(cuts[0]));
});

test('gapCuts: gaps shorter than minGap stay; disabled or missing speech returns none', () => {
  const words = [word('a', 0, 1), word('b', 1.8, 3)];
  const speech = [{ start: 0, end: 1 }, { start: 1.8, end: 3 }];
  assert.equal(gapCuts(words, speech, on, 3).length, 0); // 0.8s gap < 1.0 minGap
  const far = [word('a', 0, 1), word('b', 11, 12)];
  assert.equal(gapCuts(far, speech, { ...on, enabled: false }, 12).length, 0);
  assert.equal(gapCuts(far, undefined, on, 12).length, 0);
});

test('gapCuts: leading and trailing silence are cut; trailing needs sourceDuration', () => {
  const words = [word('a', 3, 4)];
  const speech = [{ start: 3, end: 4 }];
  const withDur = gapCuts(words, speech, on, 10);
  assert.equal(withDur.length, 2, JSON.stringify(withDur));
  assert.ok(near(withDur[0].start, 0) && near(withDur[0].end, 2.75), JSON.stringify(withDur[0])); // no margin at program start: no sliver stranded at 0
  assert.ok(near(withDur[1].start, 4.25) && near(withDur[1].end, 10), JSON.stringify(withDur[1])); // no margin at program end: no sliver stranded at sourceDuration
  assert.equal(gapCuts(words, speech, on, undefined).length, 1); // no trailing gap without a duration
});

test('deriveCuts merges word, pause and gap cuts into one list', () => {
  const words = [word('a', 0, 1), word('x', 5, 5.6, true), word('b', 11, 12)];
  const speech = [{ start: 0, end: 1 }, { start: 5, end: 5.6 }, { start: 11, end: 12 }];
  const cuts = deriveCuts({ words, pauses: [], speech, tightenPauses: on, sourceDuration: 12 });
  assert.equal(cuts.length, 1, JSON.stringify(cuts)); // deleted word swallowed by the gap cut
  assert.ok(cuts[0].start < 1.3 && cuts[0].end > 10.7, JSON.stringify(cuts[0]));
});

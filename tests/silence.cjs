const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { deriveCuts, pauseCuts, computeCuts, programDuration } = require('../src/lib/edl.ts');
const { findQuietRegions } = require('../src/lib/audio-envelope.ts');
const { captureEdits, applyEdits, validPauseSettings } = require('../src/lib/edit-state.ts');

const RATE = 16000;
const pcmOf = segments => {
  const out = [];
  for (const [sec, amp] of segments) for (let i = 0; i < Math.round(sec * RATE); i++) out.push(Math.round(amp * Math.sin((2 * Math.PI * 220 * out.length) / RATE)));
  return { sampleRate: RATE, samples: Int16Array.from(out) };
};
const LOUD = 0.3 * 32767; // about -13.5 dBFS
const QUIET_SPEECH = 32768 * 10 ** (-45 / 20) * Math.SQRT2; // a sine at -45 dBFS RMS: below -40, above -50
const on = { enabled: true, minGap: 1.0, margin: 0.25 };
const word = (id, start, end, deleted = false) => ({ id, text: id, start, end, deleted });

test('quiet regions: only audio at or below -50 dBFS, and a click under 20 ms does not split a pause', () => {
  // speech 0-1, silence 1-3 with a 10 ms click at 2.0, -45 dBFS speech 3-5, silence 5-6.5, speech 6.5-7
  const pcm = pcmOf([[1, LOUD], [1, 0], [0.01, LOUD], [0.99, 0], [2, QUIET_SPEECH], [1.5, 0], [0.5, LOUD]]);
  const regions = findQuietRegions(pcm);
  assert.equal(regions.length, 2);
  assert.ok(Math.abs(regions[0].start - 1) <= 0.011 && Math.abs(regions[0].end - 3) <= 0.011, JSON.stringify(regions[0]));
  assert.ok(Math.abs(regions[1].start - 5) <= 0.011 && Math.abs(regions[1].end - 6.5) <= 0.011, JSON.stringify(regions[1]));
});

test('a sound of 20 ms or more ends a pause (a soft word is never bridged)', () => {
  const pcm = pcmOf([[1, LOUD], [1, 0], [0.03, LOUD], [1, 0], [0.5, LOUD]]);
  assert.equal(findQuietRegions(pcm).length, 2);
});

test('pauses shorter than the minimum are untouched; longer ones keep the margin on each side', () => {
  const words = [word('a', 0, 1), word('b', 4, 5)];
  const pauses = [{ start: 1, end: 1.8 }, { start: 1.9, end: 3.9 }];
  assert.deepEqual(pauseCuts(words, pauses, on), [{ start: 2.15, end: 3.65 }]);
});

test('a word whisper placed inside a quiet stretch does not stop it being cut', () => {
  // whisper stretches "is." across 2 s of silence and invents "Thank you." on it
  const pauses = [{ start: 1, end: 4 }];
  const words = [word('is.', 0, 3), word('Thank', 3, 3.5), word('you.', 3.5, 4.2)];
  assert.deepEqual(pauseCuts(words, pauses, on), [{ start: 1.25, end: 3.75 }]);
});

test('disabled or unanalyzed == word cuts only', () => {
  const words = [word('a', 0, 1), word('um', 1, 1.3, true), word('b', 1.3, 2)];
  const pauses = [{ start: 2, end: 5 }];
  assert.deepEqual(deriveCuts({ words, pauses, tightenPauses: { ...on, enabled: false } }), computeCuts(words));
  assert.deepEqual(deriveCuts({ words, tightenPauses: on }), computeCuts(words));
  assert.deepEqual(deriveCuts({ words, pauses }), computeCuts(words));
});

test('word cuts and pause cuts merge, and the program shrinks by exactly the merged sum', () => {
  const words = [word('a', 0, 1), word('um', 1, 1.3, true), word('b', 3.3, 4)];
  const pauses = [{ start: 1.3, end: 3.3 }];
  const cuts = deriveCuts({ words, pauses, tightenPauses: { enabled: true, minGap: 1.0, margin: 0 } });
  assert.equal(cuts.length, 1);
  const sum = cuts.reduce((s, c) => s + c.end - c.start, 0);
  assert.ok(Math.abs(programDuration(cuts, 10) - (10 - sum)) < 1e-9);
  assert.ok(cuts[0].start <= 1 && cuts[0].end >= 3.3, JSON.stringify(cuts));
});

test('pause settings ride along with undo/redo and reject margins that leave nothing to cut', () => {
  const project = { words: [word('a', 0, 1)], studioSound: false };
  const before = captureEdits(project);
  project.tightenPauses = { ...on };
  const after = captureEdits(project);
  applyEdits(project, before);
  assert.equal(project.tightenPauses, undefined);
  applyEdits(project, after);
  assert.deepEqual(project.tightenPauses, on);
  assert.throws(() => applyEdits(project, { ...after, tightenPauses: { enabled: true, minGap: 1, margin: 0.5 } }), /pause settings/);
  assert.deepEqual(project.tightenPauses, on, 'a rejected edit changes nothing');
  assert.equal(validPauseSettings({ enabled: true, minGap: Infinity, margin: 0 }), false);
  assert.equal(validPauseSettings({ enabled: true, minGap: 1, margin: -0.1 }), false);
  assert.equal(validPauseSettings(on), true);
});

test('an exact-minimum region or pause qualifies wherever it starts (no float drop)', () => {
  // 0.3 s of silence at 2.0 s: 2.3 - 2 === 0.2999999999999998 in float
  const regions = findQuietRegions(pcmOf([[2, LOUD], [0.3, 0], [0.5, LOUD]]));
  assert.deepEqual(regions, [{ start: 2, end: 2.3 }]);
  // 2.3 - 1.1 === 1.1999999999999997, still a 1.2 s pause
  assert.deepEqual(pauseCuts([], [{ start: 1.1, end: 2.3 }], { enabled: true, minGap: 1.2, margin: 0 }), [{ start: 1.1, end: 2.3 }]);
});

test('a trailing quiet region never ends past the audio', () => {
  const pcm = pcmOf([[0.5, LOUD]]);
  const samples = new Int16Array(16009); samples.set(pcm.samples); // 1.0005625 s, rounds up to 1.001 at 3 dp
  const total = samples.length / RATE;
  const regions = findQuietRegions({ sampleRate: RATE, samples });
  assert.equal(regions.length, 1);
  assert.ok(regions[0].end <= total, `${regions[0].end} > ${total}`);
});

test('pause settings below the 0.3 s analysis minimum are rejected, as in the editor and MCP', () => {
  assert.equal(validPauseSettings({ enabled: true, minGap: 0.3, margin: 0 }), true);
  assert.equal(validPauseSettings({ enabled: true, minGap: 0.29, margin: 0 }), false);
});

// ── closeSlivers (MAX_SLIVER) ────────────────────────────────────────────────

test('word-only cuts: a kept gap under 0.3 s with no kept word in it merges into one cut', () => {
  const words = [word('a', 0, 1), word('x1', 1, 1.2, true), word('b', 1.2, 1.205), word('x2', 1.205, 1.4, true), word('c', 1.4, 2)];
  assert.deepEqual(deriveCuts({ words }), [{ start: 1, end: 1.4 }]);
});

test('word-only cuts: a kept word (e.g. a 0.29 s "So") inside a short gap keeps it a kept segment', () => {
  const words = [word('a', 0, 1), word('x1', 1, 1.1, true), word('So', 1.1, 1.39), word('x2', 1.39, 1.5, true), word('b', 1.5, 2)];
  assert.deepEqual(deriveCuts({ words }), [{ start: 1, end: 1.1 }, { start: 1.39, end: 1.5 }]);
});

test('word-only cuts: a kept gap of 0.3 s or more is left alone even with no kept words in it', () => {
  const words = [word('a', 0, 1), word('x1', 1, 1.2, true), word('x2', 2.0, 2.2, true), word('c', 2.2, 3)];
  assert.deepEqual(deriveCuts({ words }), [{ start: 1, end: 1.29 }, { start: 1.91, end: 2.2 }]);
});

test('pauses on: a pause cut sitting 0.06 s from a word cut, with no kept word between, merges into one', () => {
  const words = [word('a', 0, 1), word('x1', 1, 1.2, true), word('c', 1.85, 3)];
  const pauses = [{ start: 1.10, end: 2.10 }];
  assert.deepEqual(deriveCuts({ words, pauses, tightenPauses: on }), [{ start: 1, end: 1.85 }]);
});

// closeSlivers counts a kept word as speech in the gap only if it overlaps by MORE than 0.01 s
// (strictly greater, not >=). Two cuts 0.2 s apart (under MAX_SLIVER=0.3) with a kept word
// straddling the boundary between them at a controlled overlap depth.
const sliverPauses = [{ start: 1.0, end: 1.2 }, { start: 1.4, end: 1.6 }];
const sliverSettings = { enabled: true, minGap: 0.2, margin: 0 };

test('a kept word overlapping the gap by 0.008 s (<= 0.01) does not prevent the sliver merge', () => {
  const words = [word('w', 1.192, 1.208)]; // overlaps [1.2, 1.4) by exactly 0.008 s
  assert.deepEqual(deriveCuts({ words, pauses: sliverPauses, tightenPauses: sliverSettings }), [{ start: 1.0, end: 1.6 }]);
});

test('a kept word overlapping the gap by 0.02 s (> 0.01) prevents the sliver merge', () => {
  const words = [word('w', 1.192, 1.22)]; // overlaps [1.2, 1.4) by 0.02 s
  assert.deepEqual(deriveCuts({ words, pauses: sliverPauses, tightenPauses: sliverSettings }), [{ start: 1.0, end: 1.2 }, { start: 1.4, end: 1.6 }]);
});

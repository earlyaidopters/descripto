const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { parseWav, envelopeDbfs, refineBoundary, snapWordBoundaries, SNAP_WINDOW_US, SNAP_DBFS, HOP_US } = require('../src/lib/audio-envelope.ts');

const RATE = 16000;
// segments: [seconds, amplitude] — amplitude 0 is silence, else a 220 Hz tone.
function samples(segments) {
  const out = [];
  for (const [sec, amp] of segments) for (let i = 0; i < Math.round(sec * RATE); i++) out.push(Math.round(amp * Math.sin((2 * Math.PI * 220 * out.length) / RATE)));
  return Int16Array.from(out);
}
function wav(s, { rate = RATE, channels = 1, bits = 16, list = true } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * channels * bits / 8, 16); fmt.writeUInt16LE(channels * bits / 8, 20); fmt.writeUInt16LE(bits, 22);
  const extra = list ? Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('INFOx'), Buffer.from([0])]) : Buffer.alloc(0); // odd size + pad byte
  const data = Buffer.alloc(8 + s.length * 2);
  data.write('data', 0); data.writeUInt32LE(s.length * 2, 4);
  for (let i = 0; i < s.length; i++) data.writeInt16LE(s[i], 8 + i * 2);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, extra, data]);
  const head = Buffer.alloc(8); head.write('RIFF', 0); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
const loud = 0.3 * 32767;

test('parses a mono PCM16 WAV past a LIST chunk and rejects other formats', () => {
  const s = samples([[0.1, loud]]);
  const pcm = parseWav(wav(s));
  assert.equal(pcm.sampleRate, RATE);
  assert.deepEqual(Array.from(pcm.samples), Array.from(s));
  assert.throws(() => parseWav(wav(s, { channels: 2 })), /unsupported WAV/);
  assert.throws(() => parseWav(wav(s, { rate: 44100 })), /unsupported WAV/);
  assert.throws(() => parseWav(Buffer.from('not a wav file')), /RIFF/);
});

test('a truncated or odd-length data chunk is rejected, not read as silence', () => {
  const full = wav(samples([[0.1, loud]]));
  assert.throws(() => parseWav(full.subarray(0, full.length - 2)), /truncated WAV data chunk/);
  const odd = wav(samples([[0.1, loud]]));
  const at = odd.indexOf('data');
  odd.writeUInt32LE(odd.readUInt32LE(at + 4) - 1, at + 4); // 3199 bytes declared, all present
  assert.throws(() => parseWav(odd), /incomplete sample/);
});

test('envelope is one dBFS value per 10 ms hop', () => {
  const env = envelopeDbfs(parseWav(wav(samples([[0.1, loud], [0.1, 0]]))));
  assert.equal(env.length, 20);
  assert.ok(env[5] > -15 && env[5] < -10, `tone hop ${env[5]}`);
  assert.equal(env[15], -Infinity);
});

test('snaps to the onset of sustained silence near the target', () => {
  // tone 0–1.0 s, silence 1.0–1.2 s, tone after
  const pcm = parseWav(wav(samples([[1.0, loud], [0.2, 0], [1.0, loud]])));
  assert.equal(refineBoundary(pcm, 1_100_000, 500_000, 1_700_000), 1_000_000);
  assert.equal(refineBoundary(pcm, 950_000, 500_000, 1_700_000), 1_000_000);
});

test('without a held silence it snaps to the quietest hop, clamped to [lo, hi]', () => {
  // a 30 ms dip is shorter than the 60 ms hold
  const pcm = parseWav(wav(samples([[1.0, loud], [0.03, 0], [1.0, loud]])));
  assert.equal(refineBoundary(pcm, 1_050_000, 500_000, 1_700_000), 1_000_000);
  assert.equal(refineBoundary(pcm, 1_050_000, 1_020_000, 1_700_000), 1_020_000);
  assert.equal(refineBoundary(pcm, 1_050_000, 1_200_000, 1_100_000), 1_200_000); // empty range → clamped target (lo wins, as in the Python)
  assert.equal(refineBoundary(null, 2_000_000, 0, 1_000_000), 1_000_000); // no audio → clamped target
});

test('touching and overlapping pairs share one snapped boundary; real gaps are left alone', () => {
  // tone 0–1.0, silence 1.0–1.2, tone 1.2–2.0, silence 2.0–2.5, tone 2.5–3.0
  const pcm = parseWav(wav(samples([[1.0, loud], [0.2, 0], [0.8, loud], [0.5, 0], [0.5, loud]])));
  const words = [
    { start: 0.2, end: 1.1 }, // touches next at 1.1 (inside the silence)
    { start: 1.1, end: 2.1 }, // overlaps next by 0.1
    { start: 2.0, end: 2.3 }, // real gap of 0.2 to next
    { start: 2.5, end: 2.9 },
  ];
  assert.equal(snapWordBoundaries(words, pcm), 2);
  assert.equal(words[0].end, 1.0); assert.equal(words[1].start, 1.0);
  assert.equal(words[1].end, 2.0); assert.equal(words[2].start, 2.0);
  assert.equal(words[2].end, 2.3); assert.equal(words[3].start, 2.5);
  assert.deepEqual(words.map(w => [w.rawStart, w.rawEnd]), [[0.2, 1.1], [1.1, 2.1], [2.0, 2.3], [2.5, 2.9]]);
  for (const w of words) assert.ok(w.end > w.start);
});

test('a word too short to keep 30 ms on each side is not moved', () => {
  const pcm = parseWav(wav(samples([[1.0, loud]])));
  const words = [{ start: 0.5, end: 0.54 }, { start: 0.54, end: 0.56 }];
  assert.equal(snapWordBoundaries(words, pcm), 0);
  assert.deepEqual(words.map(w => [w.start, w.end]), [[0.5, 0.54], [0.54, 0.56]]);
});

test('rejects a non-PCM format and a non-16-bit WAV', () => {
  const base = wav(samples([[0.05, loud]]));
  const fmtBody = base.indexOf('fmt ') + 8;
  const badFormat = Buffer.from(base);
  badFormat.writeUInt16LE(3, fmtBody); // IEEE float (format 3), not PCM (format 1)
  assert.throws(() => parseWav(badFormat), /unsupported WAV/);
  const badBits = Buffer.from(base);
  badBits.writeUInt16LE(8, fmtBody + 14); // 8-bit, not 16-bit
  assert.throws(() => parseWav(badBits), /unsupported WAV/);
});

test('the default hold threshold (60 ms) is not satisfied by a shorter run', () => {
  // a 1-hop blip at 0.08s (never enough to hold); a 3-hop run at 0.29s (still short of
  // the 6-hop/60ms default). Neither should trigger onset detection by itself: with no
  // qualifying run, the tie-break falls to the earliest zero-RMS hop (the blip at 0.08s),
  // not the later 3-hop run.
  const pcm = parseWav(wav(samples([[0.08, loud], [0.01, 0], [0.2, loud], [0.03, 0], [0.28, loud]])));
  assert.equal(refineBoundary(pcm, 200_000, 0, 600_000), 80_000);
});

test('the floor comparison is <=: an RMS exactly at the floor counts as quiet', () => {
  const R = 1000;
  const dbfsFloor = 20 * Math.log10(R / 32768); // round-trips to floorRms === R exactly in double arithmetic
  const push = (arr, sec, amp, dc) => { for (let i = 0; i < Math.round(sec * RATE); i++) arr.push(dc ? amp : Math.round(amp * Math.sin((2 * Math.PI * 220 * arr.length) / RATE))); };
  const s = [];
  push(s, 0.08, loud, false); // tone (RMS well above R)
  push(s, 0.01, 0, true);     // region B: 1 hop of true silence (RMS 0), too short to hold
  push(s, 0.20, loud, false); // tone
  push(s, 0.06, R, true);     // region A: 6 hops of constant amplitude R, exactly at the floor
  push(s, 0.25, loud, false); // tone
  const pcm = parseWav(wav(Int16Array.from(s)));
  // region A satisfies the hold (R <= floorRms) and comes after region B, so its onset wins
  assert.equal(refineBoundary(pcm, 200_000, 0, 600_000, SNAP_WINDOW_US, dbfsFloor), 290_000);
});

test('the hold threshold decides which silence run counts as sustained', () => {
  // run A: 0.30-0.33s (3 hops). run B, later: 0.43-0.48s (5 hops). Tone elsewhere.
  const pcm = parseWav(wav(samples([[0.3, loud], [0.03, 0], [0.1, loud], [0.05, 0], [0.3, loud]])));
  const target = 390_000, lo = 0, hi = 780_000;
  // a 2-hop hold is already satisfied by the shorter run A, which comes first
  assert.equal(refineBoundary(pcm, target, lo, hi, SNAP_WINDOW_US, SNAP_DBFS, 20_000, HOP_US), 300_000);
  // a 4-hop hold is NOT met by run A (only 3 hops); run B (5 hops) is the first that qualifies
  assert.equal(refineBoundary(pcm, target, lo, hi, SNAP_WINDOW_US, SNAP_DBFS, 40_000, HOP_US), 430_000);
});

test('a touching pair targets the midpoint of the raw boundaries, not one endpoint', () => {
  // silence only around the true midpoint (1.5s); the region near rawEnd (2.0s) is tone
  const pcm = parseWav(wav(samples([[1.4, loud], [0.2, 0], [0.93, loud]])));
  const words = [{ start: 0.5, end: 2.0 }, { start: 1.0, end: 2.3 }];
  assert.equal(snapWordBoundaries(words, pcm), 1);
  assert.equal(words[0].end, 1.4);
  assert.equal(words[1].start, 1.4);
});

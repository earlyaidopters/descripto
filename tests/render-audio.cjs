const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { renderProgram, probe } = require('../src/lib/ffmpeg.ts');
test('built-in Studio Sound exports real audio and video with edited timing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'descripto-studio-test-'));
  try {
    const source = path.join(dir, 'source.mp4'), output = path.join(dir, 'edited.mp4');
    execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=size=128x72:rate=25:duration=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
    await renderProgram(source, output, [{start:0,end:0.87},{start:2,end:3}], {studioSound:true,hasAudio:true,total:1.87}, () => {});
    const info = await probe(output);
    assert.ok(info.hasAudio); assert.ok(info.hasVideo);
    assert.ok(Math.abs(info.duration - 1.87) < 0.05, `Expected 1.87s after cut, received ${info.duration}s`);
    assert.ok(fs.statSync(output).size > 1000);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
const { renderFilterGraph } = require('../src/lib/ffmpeg.ts');
test('video is rendered as one stream, never one branch per kept range', () => {
  const keeps = Array.from({ length: 81 }, (_, i) => ({ start: i * 12, end: i * 12 + 10 }));
  const { filter, maps } = renderFilterGraph(keeps, { studioSound: true, hasAudio: true, frameRate: 30 });
  const chains = filter.split(';');
  assert.equal(chains.filter(c => c.startsWith('[0:v]')).length, 1, 'exactly one video chain');
  assert.ok(!/concat=n=\d+:v=1/.test(filter), 'no video concat');
  assert.ok(filter.includes("[0:v]fps=30.000,select='gte(t\\,0.000)*lt(t\\,10.000)+gte(t\\,12.000)"), filter.slice(0, 120));
  assert.ok(chains[0].endsWith(',setpts=N/FRAME_RATE/TB[vout]'), 'gaps are closed by regenerating timestamps');
  assert.equal(chains.filter(c => c.startsWith('[0:a]atrim')).length, 81);
  assert.deepEqual(maps, ['-map', '[vout]', '-map', '[aout]']);
  assert.throws(() => renderFilterGraph([], { studioSound: false, hasAudio: false }));
});
test('many cuts keep audio and video the same length', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'descripto-cuts-test-'));
  try {
    const source = path.join(dir, 'source.mp4'), output = path.join(dir, 'edited.mp4');
    execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc=size=128x72:rate=25:duration=12','-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
    const keeps = Array.from({ length: 40 }, (_, i) => ({ start: i * 0.3 + 0.07, end: i * 0.3 + 0.23 }));
    const total = keeps.reduce((s, k) => s + k.end - k.start, 0);
    await renderProgram(source, output, keeps, { studioSound: false, hasAudio: true, total, frameRate: 25 }, () => {});
    const streams = JSON.parse(execFileSync('ffprobe', ['-v','error','-print_format','json','-show_streams',output]).toString()).streams;
    const v = parseFloat(streams.find(s => s.codec_type === 'video').duration), a = parseFloat(streams.find(s => s.codec_type === 'audio').duration);
    assert.ok(Math.abs(v - total) < 0.04, `video ${v}s vs program ${total}s`);
    assert.ok(Math.abs(a - total) < 0.05, `audio ${a}s vs program ${total}s`);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

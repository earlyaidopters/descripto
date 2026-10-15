const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { compressForUpload, GROQ_UPLOAD_LIMIT } = require('../src/lib/transcribe.ts');
test('a 17-minute recording is sent to Groq under its 25 MB upload cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'descripto-upload-test-'));
  try {
    const wav = path.join(dir, 'audio16k.wav');
    execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','sine=frequency=220:duration=1020','-ac','1','-ar','16000','-c:a','pcm_s16le',wav]);
    assert.ok(fs.statSync(wav).size > GROQ_UPLOAD_LIMIT, 'the raw wav is over the cap, which is what used to be uploaded');
    const upload = await compressForUpload(wav);
    assert.equal(upload, path.join(dir, 'audio16k.upload.mp3'));
    const size = fs.statSync(upload).size;
    assert.ok(size < GROQ_UPLOAD_LIMIT / 3, `compressed upload is ${size} bytes`);
    const info = JSON.parse(execFileSync('ffprobe', ['-v','error','-print_format','json','-show_streams',upload]).toString()).streams[0];
    assert.equal(info.codec_name, 'mp3'); assert.equal(info.channels, 1);
    assert.ok(Math.abs(parseFloat(info.duration) - 1020) < 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Run with node --no-experimental-strip-types --test tests/connections.cjs.
// TypeScript is compiled in memory; all keys, storage and HTTP responses are fake.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'descripto-connections-test-'));
const oldHome = process.env.HOME;
process.env.HOME = temp;
process.env.DESCRIPTO_CONFIG_DIR = path.join(temp, 'config');
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AUPHONIC_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_CONTENT_ENGINE']) delete process.env[name];
fs.writeFileSync(path.join(temp, '.env'), 'GOOGLE_API_KEY=fake-environment-key\n');
const { updateSettings, readSettings, settingsPath, preferences } = require('../src/lib/settings.ts');
const { serviceKey, connectionStatus } = require('../src/lib/env.ts');
const { trustedSettingsRequest } = require('../src/lib/settings-http.ts');
const { testConnection } = require('../src/lib/test-connection.ts');
const { processAuphonicAudio } = require('../src/lib/auphonic.ts');
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; process.env.HOME = oldHome; delete process.env.DESCRIPTO_CONFIG_DIR; fs.rmSync(temp, { recursive: true, force: true }); });

test('keys replace environment immediately; removal prevents fallback; responses contain no key', () => {
  assert.equal(serviceKey('gemini'), 'fake-environment-key');
  updateSettings({ provider: 'gemini', action: 'save', key: 'fake-saved-key' });
  assert.equal(serviceKey('gemini'), 'fake-saved-key');
  assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(settingsPath())).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(connectionStatus()).includes('fake-'), false);
  updateSettings({ provider: 'gemini', action: 'remove' });
  assert.equal(serviceKey('gemini'), '');
  assert.equal(fs.readFileSync(settingsPath(), 'utf8').includes('fake-saved-key'), false);
  updateSettings({ provider: 'gemini', action: 'environment' });
  assert.equal(serviceKey('gemini'), 'fake-environment-key');
});
test('preferences persist without losing keys; invalid writes preserve settings', () => {
  updateSettings({ provider: 'groq', action: 'save', key: 'fake-groq' });
  updateSettings({ preferences: { audioProcessor: 'auphonic', geminiModel: 'custom-model' } });
  assert.equal(serviceKey('groq'), 'fake-groq');
  assert.equal(preferences().geminiModel, 'custom-model');
  assert.throws(() => updateSettings({ preferences: { geminiModel: '../../escape' } }));
  assert.throws(() => updateSettings({ provider: 'gemini', action: 'save', key: 'bad\nkey' }));
  assert.throws(() => updateSettings({ provider: 'unknown', action: 'remove' }));
  assert.equal(preferences().geminiModel, 'custom-model');
  const original = fs.readFileSync(settingsPath(), 'utf8');
  fs.writeFileSync(settingsPath(), '{broken');
  assert.throws(() => updateSettings({ preferences: { audioProcessor: 'local' } }));
  assert.equal(fs.readFileSync(settingsPath(), 'utf8'), '{broken');
  fs.writeFileSync(settingsPath(), original);
});
test('settings reject remote hosts and cross-origin or untyped writes', () => {
  const req = (headers = {}, method = 'PATCH') => new Request('http://localhost:3212/api/settings', { method, headers });
  assert.equal(!!trustedSettingsRequest(req({ origin: 'http://localhost:3212', 'content-type': 'application/json' })), true);
  assert.equal(!!trustedSettingsRequest(req({ origin: 'https://evil.test', 'content-type': 'application/json' })), false);
  assert.equal(!!trustedSettingsRequest(req({ host: 'evil.test' }, 'GET')), false);
  assert.equal(!!trustedSettingsRequest(req({ 'sec-fetch-site': 'cross-site' }, 'GET')), false);
  assert.equal(!!trustedSettingsRequest(req()), false);
});
test('connection checks use correct headers and never expose upstream error bodies', async () => {
  for (const provider of ['gemini', 'anthropic', 'groq', 'auphonic']) {
    global.fetch = async (url, init) => {
      assert.equal(String(url).includes('fake-test-key'), false);
      assert.ok(Object.values(init.headers).some(v => v.includes('fake-test-key')));
      return Response.json({ status_code: 200, data: {} });
    };
    assert.match(await testConnection(provider, 'fake-test-key'), /Key accepted/);
  }
  global.fetch = async () => new Response('fake-secret-in-provider-error', { status: 401 });
  await assert.rejects(testConnection('gemini', 'fake'), error => !error.message.includes('fake-secret') && /not accepted/.test(error.message));
  global.fetch = async () => { throw new Error('fake-secret'); };
  await assert.rejects(testConnection('groq', 'fake'), /Could not reach/);
});
const uuid = '1234567890123456789012';
const input = path.join(temp, 'input.flac');
fs.writeFileSync(input, 'fake-audio');
function mockAuphonic(mode = 'done') {
  const calls = [];
  global.fetch = async (url, init) => {
    const address = String(url); calls.push(address);
    if (address.endsWith('/productions.json')) {
      const payload = JSON.parse(init.body);
      assert.equal(payload.algorithms.silence_cutter, false);
      assert.deepEqual(payload.outgoing_services, []);
      return Response.json({ status_code: 200, data: { uuid } });
    }
    if (address.endsWith('/status.json')) return Response.json({ status_code: 200, data: mode === 'failed' ? { error_status: 1 } : { status: mode === 'timeout' ? 2 : 3 } });
    if (address.endsWith(`/${uuid}.json`)) return Response.json({ status_code: 200, data: { output_files: [{ format: 'flac', download_url: mode === 'unsafe' ? 'https://evil.test/audio' : 'https://auphonic.com/api/download/audio-result/test/audio.flac' }] } });
    if (address.includes('/api/download/')) return new Response('finished-audio');
    return Response.json({ status_code: 200, data: { uuid } });
  };
  return calls;
}
test('Auphonic creates, uploads, starts, polls and downloads without changing timing', async () => {
  const calls = mockAuphonic(); const output = path.join(temp, 'out.flac');
  await processAuphonicAudio(input, output, 'fake-auphonic', () => {}, { pollMs: 0 });
  assert.equal(fs.readFileSync(output, 'utf8'), 'finished-audio');
  assert.equal(calls.length, 6);
  assert.ok(calls[1].endsWith('/upload.json')); assert.ok(calls[2].endsWith('/start.json'));
});
test('Auphonic failures, unsafe download URLs and timeout stop export', async () => {
  for (const [mode, expected] of [['failed', /processing failed/], ['unsafe', /unexpected download/], ['timeout', /taking longer/]]) {
    mockAuphonic(mode);
    await assert.rejects(processAuphonicAudio(input, path.join(temp, 'error.flac'), 'fake', () => {}, { timeoutMs: mode === 'timeout' ? 0 : 1000, pollMs: 0 }), expected);
  }
  global.fetch = originalFetch;
});
test('Auphonic follows media-host redirects and rejects credential redirects elsewhere', async () => {
  const base = mockAuphonic();
  const upstream = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://auphonic.com/api/download/')) {
      assert.equal(new URL(url).searchParams.get('bearer_token'), 'fake-token');
      return new Response(null, { status: 302, headers: { location: 'https://media.auphonic.com/finished.flac' } });
    }
    if (String(url).startsWith('https://media.auphonic.com/')) { assert.equal(init.headers, undefined); assert.equal(String(url).includes('fake-token'), false); return new Response('redirected-audio'); }
    return upstream(url, init);
  };
  const output = path.join(temp, 'redirect.flac');
  await processAuphonicAudio(input, output, 'fake-token', () => {});
  assert.equal(fs.readFileSync(output, 'utf8'), 'redirected-audio');
  const goodFetch = global.fetch;
  // Since 2026-10 Auphonic redirects downloads to a pre-signed Cloudflare R2 URL.
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://auphonic.com/api/download/')) return new Response(null, { status: 302, headers: { location: 'https://ab7e85693fce51fdca76bafbd20afa6a.r2.cloudflarestorage.com/bucket/finished.flac?X-Amz-Signature=abc' } });
    if (String(url).includes('.r2.cloudflarestorage.com/')) { assert.equal(init.headers, undefined); assert.equal(String(url).includes('fake-token'), false); return new Response('r2-audio'); }
    return goodFetch(url, init);
  };
  await processAuphonicAudio(input, output, 'fake-token', () => {});
  assert.equal(fs.readFileSync(output, 'utf8'), 'r2-audio');
  global.fetch = async (url, init) => String(url).startsWith('https://auphonic.com/api/download/') ? new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } }) : goodFetch(url, init);
  await assert.rejects(processAuphonicAudio(input, output, 'fake-token', () => {}), /unexpected download redirect/);
  global.fetch = async (url, init) => String(url).startsWith('https://auphonic.com/api/download/') ? new Response(null, { status: 302, headers: { location: 'https://evil.r2.cloudflarestorage.com.attacker.test/x' } }) : goodFetch(url, init);
  await assert.rejects(processAuphonicAudio(input, output, 'fake-token', () => {}), /unexpected download redirect/);
  global.fetch = async (url, init) => String(url).startsWith('https://auphonic.com/api/download/') ? new Response(null, { status: 302, headers: { location: 'https://notauphonic.com/x' } }) : goodFetch(url, init);
  await assert.rejects(processAuphonicAudio(input, output, 'fake-token', () => {}), /unexpected download redirect/);
  global.fetch = originalFetch;
});
test('audio remux preserves video duration and includes finished audio', async () => {
  const { execFileSync } = require('node:child_process');
  const { extractFinishingAudio, replaceAudio, probe } = require('../src/lib/ffmpeg.ts');
  const video = path.join(temp, 'synthetic.mp4');
  const audio = path.join(temp, 'synthetic.flac');
  const output = path.join(temp, 'remux.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
  await extractFinishingAudio(video, audio);
  const before = await probe(video);
  await replaceAudio(video, audio, output, before.duration);
  const after = await probe(output);
  assert.equal(after.hasAudio, true); assert.equal(after.hasVideo, true);
  assert.ok(Math.abs(before.duration - after.duration) < 0.05);
});
test('cancelling Auphonic polling stops only the production for this export', async () => {
  const controller = new AbortController();
  const calls = [];
  const uuid = 'abcdefghijklmnopqrstuv';
  const input = path.join(temp, 'cancel-input.flac'); fs.writeFileSync(input, 'test');
  global.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/status.json')) controller.abort();
    return new Response(JSON.stringify({ status_code: 200, data: { uuid, status: 1 } }), { status: 200 });
  };
  try {
    await assert.rejects(processAuphonicAudio(input, path.join(temp, 'cancel-output.flac'), 'fake-key', () => {}, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.at(-1), `https://auphonic.com/api/production/${uuid}/stop.json`);
    assert.equal(calls.filter(url => url.endsWith('/stop.json')).length, 1);
    assert.equal(fs.existsSync(path.join(temp, 'cancel-output.flac')), false);
  } finally { global.fetch = originalFetch; }
});

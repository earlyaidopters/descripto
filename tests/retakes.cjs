const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { similarity, segmentWords, findRetakes, findStutters, WINDOWED_THRESHOLD } = require('../src/lib/retakes.ts');
const { DEFAULT_PAUSES } = require('../src/lib/edl.ts');
const { parseAiRetakes, aiRetakePrompt, AI_RETAKE_SYSTEM_PROMPT, AI_RETAKE_MODEL, AI_RETAKE_EFFORT } = require('../src/lib/retakes-ai.ts');
const crypto = require('node:crypto');

// One word per 0.3 s; each sentence is its own phrase.
const script = (...sentences) => {
  const words = [];
  for (const s of sentences) for (const t of s.split(' ')) { const i = words.length; words.push({ id: `w${i}`, text: t, start: i * 0.3, end: i * 0.3 + 0.3, deleted: false }); }
  return words;
};
const summary = r => r.map(x => `${x.kind}: ${x.bad.text} -> ${x.good.text}`);

// ── AI retake contract (ADR-007): model, effort, and the prompt pinned verbatim ─
// capcut's core/ai_detector.py _SYSTEM_PROMPT, with AI_LOOK_AHEAD=10 substituted, hashes to this
// sha256 (computed 2026-10-14 from capcut's own source via `python3 -I -c "import ast; ..."`,
// confirmed byte-identical to the descripto constant with `diff`). A change to either copy, or
// the two drifting apart, changes this hash.
const CAPCUT_PROMPT_SHA256 = '186bea9535ab67c2256e9a6d4173186d306b59def47f586702e1832dcf1cc948';

test('AI_RETAKE_SYSTEM_PROMPT is pinned to the exact capcut _SYSTEM_PROMPT (sha256)', () => {
  const hash = crypto.createHash('sha256').update(AI_RETAKE_SYSTEM_PROMPT).digest('hex');
  assert.equal(hash, CAPCUT_PROMPT_SHA256);
});

test('AI retake check runs claude-sonnet-5 at medium effort', () => {
  assert.equal(AI_RETAKE_MODEL, 'claude-sonnet-5');
  assert.equal(AI_RETAKE_EFFORT, 'medium');
});

// ── stutter cap (STUTTER_MAX_WORDS) ─────────────────────────────────────────
// findStutters operates on the flat kept-word list directly (not through segmentWords, whose
// SEGMENT_MAX_WORDS=25 would otherwise split a 26-word run before the cap could be exercised).
const RUN_12 = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
const RUN_13 = `${RUN_12} mike`;

test('a 12-word run repeated back to back is flagged as a stutter (at the cap)', () => {
  const words = script(`${RUN_12} ${RUN_12}.`);
  const stutters = findStutters(words);
  assert.equal(stutters.length, 1);
  assert.equal(stutters[0].bad.text, RUN_12);
  assert.equal(stutters[0].good.text, `${RUN_12}.`); // the trailing sentence period lands on the last word
});

test('a 13-word run repeated back to back is NOT flagged as a stutter (above the cap)', () => {
  const words = script(`${RUN_13} ${RUN_13}.`);
  assert.equal(findStutters(words).length, 0);
});

test('similarity matches difflib.SequenceMatcher.ratio on word lists', () => {
  // values computed with python3 difflib on the same inputs
  assert.equal(similarity('a b c d'.split(' '), 'a b x d'.split(' ')), 0.75);
  assert.equal(similarity('so the thing is'.split(' '), 'so the thing is that we'.split(' ')), 0.8);
  assert.equal(+similarity('a b a b c'.split(' '), 'b a b c a'.split(' ')).toFixed(6), 0.8);
  assert.equal(similarity([], ['a']), 0);
});

test('a repeated sentence flags the earlier take and keeps the last', () => {
  const r = findRetakes(script('So here is the whole game today.', 'So here is the whole game.', 'Next topic now.'));
  assert.deepEqual(summary(r), ['adjacent: So here is the whole game today. -> So here is the whole game.']);
});

test('three takes all point to the final one', () => {
  const r = findRetakes(script('The first play is Darnold.', 'The first play is Darnold over.', 'The first play is Darnold over four.'));
  assert.deepEqual(r.map(x => x.good.text), ['The first play is Darnold over four.', 'The first play is Darnold over four.']);
});

test('a false start that the next phrase restarts is flagged (prefix)', () => {
  const r = findRetakes(script('So the first play guys is.', 'So the first play I am taking is Darnold over four.'));
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'prefix');
});

test('negation and different figures are different statements, not retakes', () => {
  assert.deepEqual(findRetakes(script('I am taking that one.', 'I am not taking that one.')), []);
  assert.deepEqual(findRetakes(script('Take a look at the 54.5 on the under.', 'Take a look at the 47.5 on the under.')), []);
});

test('a restart phrase marks the phrase that says it', () => {
  const r = findRetakes(script('Wait let me try that again.', 'Darnold goes over.'));
  assert.deepEqual(summary(r), ['keyword: Wait let me try that again. -> Darnold goes over.']);
});

test('words already cut (deleted, or inside a cut pause) are never compared', () => {
  const words = script('So here is the whole game today.', 'So here is the whole game.');
  assert.equal(findRetakes(words, [], [{ start: words[6].start, end: words[11].end }]).length, 0); // keeper is inside a cut
  for (const w of words.slice(0, 7)) w.deleted = true; // the bad take is gone once cut
  assert.equal(findRetakes(words).length, 0);
});

test('a long pause splits a phrase even without punctuation', () => {
  const words = script('one two three four five six');
  assert.equal(segmentWords(words).length, 1);
  // whisper stretches words over silence: the pause goes after the last word whose midpoint precedes its own (0.95)
  assert.deepEqual(segmentWords(words, [{ start: 0.5, end: 1.4 }]).map(s => s.text), ['one two three', 'four five six']);
  assert.equal(segmentWords(words, [{ start: 0.6, end: 1.35 }]).length, 1); // 0.75 s < 0.8 s
});

test('a chain never ends on a keeper the negation or figure checks would reject', () => {
  // A -> B (adjacent), B -> C (restart phrase): consolidation must not pair A with C
  for (const [a, b, c] of [['I like this plan.', 'I like this plan start over.', 'I do not like this plan.'], ['The line is 5 points.', 'The line is 5 points start over.', 'The line is 7 points.']]) {
    const r = findRetakes(script(a, b, c));
    assert.ok(!r.some(x => x.bad.text === a), summary(r).join('; '));
    assert.deepEqual(r.filter(x => x.bad.text === b).map(x => x.kind), ['keyword']);
  }
});

test('a straggler rejected by one keeper is still matched to a later one', () => {
  const r = findRetakes(script(
    'Darnold goes over 4 rushing yards.', 'Alpha bravo charlie.', 'Delta echo foxtrot.', 'Golf hotel india.',
    'Darnold goes over 5 rushing yards.', 'Darnold goes over 5 rushing yards.', 'Juliet kilo lima.', 'Mike november oscar.', 'Papa quebec romeo.',
    'Darnold goes over 4 rushing yards tonight.', 'Darnold goes over 4 rushing yards tonight.'));
  const x = r.find(p => p.bad.text === 'Darnold goes over 4 rushing yards.');
  assert.ok(x, summary(r).join('; '));
  assert.equal(x.kind, 'straggler');
  assert.equal(x.good.wordIds[0], r.find(p => p.bad.text === 'Darnold goes over 4 rushing yards tonight.').good.wordIds[0]);
});

test('signs and leading points are part of a figure; a trailing full stop is not', () => {
  assert.deepEqual(findRetakes(script('We said the value is -5.', 'We said the value is 5.')), []);
  assert.deepEqual(findRetakes(script('We said the value is .5 again.', 'We said the value is 5 again.')), []);
  assert.equal(findRetakes(script('We said the value is 5.', 'We said the value is 5 again.')).length, 1);
});

// A crude tokenizer, just to assert (independently of the implementation's own `tokens()`)
// that the filler phrases below genuinely don't resemble each other or the real phrase.
const wtok = (s) => s.toLowerCase().split(' ');

test('a windowed match 3 phrases later is flagged; the same match 4 phrases later is not', () => {
  const real = 'Darnold goes over four and a half yards tonight for the team.';
  const retake = 'Darnold goes over four and a half yards tonight for the squad.';
  const fillerA = 'Alpha bravo charlie delta echo foxtrot golf hotel.';
  const fillerB = 'Kilo lima mike november oscar papa quebec romeo.';
  const fillerC = 'Uniform victor whiskey xray yankee zulu apple banana.';

  // Guard: fillers must be dissimilar to each other and to the real phrase, and the
  // real/retake pair must actually clear WINDOWED_THRESHOLD, or this test proves nothing.
  for (const f of [fillerA, fillerB, fillerC]) {
    assert.ok(similarity(wtok(real), wtok(f)) < WINDOWED_THRESHOLD, `filler too similar to real: ${f}`);
  }
  assert.ok(similarity(wtok(fillerA), wtok(fillerB)) < WINDOWED_THRESHOLD, 'fillers too similar to each other');
  assert.ok(similarity(wtok(fillerB), wtok(fillerC)) < WINDOWED_THRESHOLD, 'fillers too similar to each other');
  assert.ok(similarity(wtok(fillerA), wtok(fillerC)) < WINDOWED_THRESHOLD, 'fillers too similar to each other');
  assert.ok(similarity(wtok(real), wtok(retake)) >= WINDOWED_THRESHOLD, 'real/retake pair must clear the windowed threshold');
  // Neither phrase contains a negation word or a figure, so the compatibility guards
  // (negation parity, figure parity) can never be the reason a pairing is rejected here.

  // Distance 3 (i=0, j=3): inside the WINDOW=3 lookahead -> flagged as "windowed".
  const r3 = findRetakes(script(real, fillerA, fillerB, retake));
  assert.deepEqual(summary(r3), [`windowed: ${real} -> ${retake}`]);

  // Distance 4 (i=0, j=4): one phrase further than the windowed pass looks -> not flagged.
  const r4 = findRetakes(script(real, fillerA, fillerB, fillerC, retake));
  assert.deepEqual(r4, []);
});

test('segmentWords splits a long punctuation-free, pause-free run every SEGMENT_MAX_WORDS words', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const words = script(thirty);
  const segs = segmentWords(words);
  assert.deepEqual(segs.map((s) => s.wordIds.length), [25, 5]);
  assert.equal(segs[0].wordIds[0], 'w0');
  assert.equal(segs[0].wordIds[24], 'w24');
  assert.equal(segs[1].wordIds[0], 'w25');
  assert.equal(segs[1].wordIds[4], 'w29');
});

test('a restart-phrase pair is kind "keyword" with similarity 1 even sharing no words', () => {
  const r = findRetakes(script('Scratch that.', 'Banana kayak umbrella forest.'));
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'keyword');
  assert.equal(r[0].similarity, 1);
  const badWords = new Set(r[0].bad.text.toLowerCase().replace(/[.]/g, '').split(' '));
  const goodWords = new Set(r[0].good.text.toLowerCase().replace(/[.]/g, '').split(' '));
  assert.equal([...badWords].filter((w) => goodWords.has(w)).length, 0, 'bad/good should share no words');
});

test('DEFAULT_PAUSES matches ADR-005: disabled by default, minGap 1, margin 0.25', () => {
  assert.deepEqual(DEFAULT_PAUSES, { enabled: false, minGap: 1.0, margin: 0.25 });
});

// ── Figure guard: a keeper may ADD figures ──────────────────────────────────

test('figure guard: a keeper may add a figure the bad take never had', () => {
  const r = findRetakes(script('So because that line shifted away from them.', 'So because that line shifted away from them it moved 60 points.'));
  assert.equal(r.length, 1);
  assert.equal(r[0].bad.text, 'So because that line shifted away from them.');
  assert.equal(r[0].good.text, 'So because that line shifted away from them it moved 60 points.');
});

// ── findStutters / the stutter pass inside findRetakes ──────────────────────

test('a run of 3+ words said twice back to back in one phrase is a single "stutter" retake', () => {
  const r = findRetakes(script('on top of that every quarterback on top of that every quarterback faced Denver.'));
  const stutters = r.filter((x) => x.kind === 'stutter');
  assert.equal(stutters.length, 1);
  assert.equal(stutters[0].bad.text, 'on top of that every quarterback');
  assert.equal(stutters[0].good.text, 'on top of that every quarterback');
  assert.deepEqual(stutters[0].bad.wordIds, ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
  assert.deepEqual(stutters[0].good.wordIds, ['w6', 'w7', 'w8', 'w9', 'w10', 'w11']);
});

test('a 2-word repeat is not flagged as a stutter', () => {
  const r = findRetakes(script('it is it is fine today.'));
  assert.equal(r.filter((x) => x.kind === 'stutter').length, 0);
});

test('number shorthand ("two two two two two two") is not flagged as a stutter', () => {
  const r = findRetakes(script('the total was two two two two two two points.'));
  assert.equal(r.filter((x) => x.kind === 'stutter').length, 0);
});

test('a repeat spanning two phrases is not reported as kind "stutter"', () => {
  // "every quarterback that has faced" ends phrase 1 and opens phrase 2: an immediately
  // back-to-back repeat, but split across a sentence end, so the per-phrase stutter pass
  // (which searches inside one segment only) can never see it. Both phrases are deliberately
  // too dissimilar overall to trip the phrase-level adjacent/windowed/prefix passes either.
  const r = findRetakes(script('so here is the plan every quarterback that has faced.', 'every quarterback that has faced Denver this season really struggled.'));
  assert.equal(r.filter((x) => x.kind === 'stutter').length, 0);
});

test('a repeated phrase whose sign differs is not flagged as a stutter', () => {
  const r = findRetakes(script('the value is -5 points the value is 5 points.'));
  assert.equal(r.filter((x) => x.kind === 'stutter').length, 0);
});

// ── AI merge in findRetakes(words, pauses, cuts, ai) ────────────────────────

test('an AI pair is included as kind "ai" with its reason while every word is still kept', () => {
  const words = script('Alpha bravo charlie delta echo.');
  const ai = { pairs: [{ badIds: [words[0].id, words[1].id], goodIds: [words[2].id, words[3].id], confidence: 0.9, reason: 'restart' }] };
  const r = findRetakes(words, [], [], ai);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'ai');
  assert.equal(r[0].reason, 'restart');
  assert.equal(r[0].similarity, 0.9);
});

test('an AI pair is dropped once one of its words is deleted', () => {
  const words = script('Alpha bravo charlie delta echo.');
  const ai = { pairs: [{ badIds: [words[0].id, words[1].id], goodIds: [words[2].id, words[3].id], confidence: 0.9, reason: 'restart' }] };
  words[0].deleted = true;
  assert.deepEqual(findRetakes(words, [], [], ai).filter((x) => x.kind === 'ai'), []);
});

test('an AI pair is dropped once one of its words falls inside a cut range', () => {
  const words = script('Alpha bravo charlie delta echo.');
  const ai = { pairs: [{ badIds: [words[0].id, words[1].id], goodIds: [words[2].id, words[3].id], confidence: 0.9, reason: 'restart' }] };
  const r = findRetakes(words, [], [{ start: words[0].start, end: words[0].end }], ai);
  assert.deepEqual(r.filter((x) => x.kind === 'ai'), []);
});

test('an AI pair overlapping a take the local passes already flagged is not added (no duplicate)', () => {
  const words = script('So here is the whole game today.', 'So here is the whole game.');
  const ai = { pairs: [{ badIds: [words[0].id], goodIds: [words[8].id], confidence: 0.9, reason: 'dup' }] };
  const r = findRetakes(words, [], [], ai);
  assert.equal(r.filter((x) => x.kind === 'ai').length, 0);
  assert.equal(r.filter((x) => x.kind === 'adjacent').length, 1);
});

test('AI results merge in sorted order by bad.start', () => {
  const words = script('Alpha bravo charlie.', 'Delta echo foxtrot.', 'Golf hotel india.', 'Juliet kilo lima.');
  const segs = segmentWords(words);
  const ai = {
    pairs: [
      { badIds: segs[2].wordIds, goodIds: segs[3].wordIds, confidence: 0.9, reason: 'later' },
      { badIds: segs[0].wordIds, goodIds: segs[1].wordIds, confidence: 0.9, reason: 'earlier' },
    ],
  };
  const r = findRetakes(words, [], [], ai);
  assert.deepEqual(r.map((x) => x.reason), ['earlier', 'later']);
});

// ── parseAiRetakes(text, segments) ──────────────────────────────────────────

const aiSegs = () => segmentWords(script('Zero segment text.', 'One segment text.', 'Two segment text.', 'Three segment text.', 'Four segment text.'));

test('parseAiRetakes accepts a plain JSON array', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([{ bad_index: 1, good_index: 2, confidence: 0.8, reason: 'r' }]), segs);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].badIds, segs[1].wordIds);
  assert.deepEqual(out[0].goodIds, segs[2].wordIds);
  assert.equal(out[0].confidence, 0.8);
  assert.equal(out[0].reason, 'r');
});

test('parseAiRetakes accepts a JSON array wrapped in ```json fences', () => {
  const segs = aiSegs();
  const text = '```json\n' + JSON.stringify([{ bad_index: 1, good_index: 2, confidence: 0.8, reason: 'r' }]) + '\n```';
  assert.equal(parseAiRetakes(text, segs).length, 1);
});

test('parseAiRetakes drops bad_index 0 (the hook)', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([{ bad_index: 0, good_index: 2, confidence: 0.9, reason: 'r' }]), segs);
  assert.deepEqual(out, []);
});

test('parseAiRetakes drops a pair where bad >= good, including bad === good', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([
    { bad_index: 2, good_index: 1, confidence: 0.9, reason: 'r' },
    { bad_index: 2, good_index: 2, confidence: 0.9, reason: 'r' },
  ]), segs);
  assert.deepEqual(out, []);
});

test('parseAiRetakes drops out-of-range indices', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([
    { bad_index: -1, good_index: 2, confidence: 0.9, reason: 'r' },
    { bad_index: 1, good_index: 99, confidence: 0.9, reason: 'r' },
  ]), segs);
  assert.deepEqual(out, []);
});

test('parseAiRetakes drops confidence < 0.75', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([{ bad_index: 1, good_index: 2, confidence: 0.74, reason: 'r' }]), segs);
  assert.deepEqual(out, []);
});

test('parseAiRetakes drops a second pair with the same bad index', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([
    { bad_index: 1, good_index: 2, confidence: 0.9, reason: 'first' },
    { bad_index: 1, good_index: 3, confidence: 0.9, reason: 'second' },
  ]), segs);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'first');
});

test('parseAiRetakes drops a pair whose bad is an earlier pair\'s good', () => {
  const segs = aiSegs();
  const out = parseAiRetakes(JSON.stringify([
    { bad_index: 1, good_index: 2, confidence: 0.9, reason: 'first' },
    { bad_index: 2, good_index: 3, confidence: 0.9, reason: 'chained' },
  ]), segs);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'first');
});

test('parseAiRetakes throws an Error containing "non-JSON" on non-JSON text', () => {
  assert.throws(() => parseAiRetakes('not json at all', aiSegs()), /non-JSON/);
});

test('parseAiRetakes returns [] for a non-array JSON value', () => {
  assert.deepEqual(parseAiRetakes(JSON.stringify({ bad_index: 1, good_index: 2 }), aiSegs()), []);
});

// ── aiRetakePrompt(segments) ─────────────────────────────────────────────────

test('aiRetakePrompt names the hook and formats one "i | m:ss | text" line per segment', () => {
  const segs = aiSegs();
  const prompt = aiRetakePrompt(segs);
  assert.ok(prompt.includes('The HOOK is segment 0'));
  segs.forEach((s, i) => {
    const mm = Math.floor(s.start / 60), ss = String(Math.floor(s.start % 60)).padStart(2, '0');
    assert.ok(prompt.includes(`${i} | ${mm}:${ss} | ${s.text}`), `missing formatted line for segment ${i}`);
  });
});

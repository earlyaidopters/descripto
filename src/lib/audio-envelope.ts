import fs from "fs";

// ── Audio envelope + boundary snap ──────────────────────────────────────────
// Groq whisper returns contiguous word spans (word.end == next.start), so the
// transcript alone cannot say where one word stops and the next begins (ADR-002).
// We read the 16 kHz mono PCM16 WAV that transcribe() already extracts and snap
// each shared boundary into the quietest nearby audio. Port of capcut's
// refine_boundary (my-project/capcut/core/audio_analysis.py, ADR-030).

const FULL_SCALE = 32768; // int16 max magnitude, dBFS reference
export const SNAP_WINDOW_US = 150_000; // ±150 ms search around the target
export const SNAP_DBFS = -40; // "silent enough" floor
export const SNAP_HOLD_US = 60_000; // silence must hold ≥ 60 ms
export const HOP_US = 10_000; // 10 ms analysis hop

export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

// Parse a RIFF/WAVE file. Walks the chunk list (ffmpeg writes a LIST chunk
// before data, so the header is not a fixed 44 bytes). Only mono PCM16 is accepted.
export function parseWav(buf: Buffer, expectRate = 16000): Pcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (size > buf.length - body) throw new Error(`truncated WAV ${id} chunk`); // missing audio must not read as silence
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV fmt chunk too short");
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate !== expectRate) throw new Error(`unsupported WAV: format ${fmt.format}, ${fmt.channels} ch, ${fmt.bits} bit, ${fmt.rate} Hz (want PCM mono 16 bit ${expectRate} Hz)`);
      if (size % 2 !== 0) throw new Error("WAV PCM16 data has an incomplete sample");
      const n = size / 2;
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: fmt.rate, samples };
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}

export function readWav(path: string, expectRate = 16000): Pcm {
  return parseWav(fs.readFileSync(path), expectRate);
}

const usToIndex = (us: number, rate: number) => Math.floor((us * rate) / 1_000_000);

function windowRms(s: Int16Array, i0: number, i1: number): number {
  i1 = Math.min(i1, s.length);
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / (i1 - i0));
}

// RMS per 10 ms hop in dBFS (-Infinity for digital silence).
export function envelopeDbfs(pcm: Pcm, hopUs = HOP_US): Float64Array {
  const hop = Math.max(1, usToIndex(hopUs, pcm.sampleRate));
  const out = new Float64Array(Math.ceil(pcm.samples.length / hop));
  for (let k = 0; k < out.length; k++) out[k] = 20 * Math.log10(windowRms(pcm.samples, k * hop, (k + 1) * hop) / FULL_SCALE);
  return out;
}

// Refined boundary (µs) near targetUs, clamped to [loUs, hiUs]. Prefers the
// onset of the first ≥ holdUs run at or below dbfsFloor; else the quietest hop;
// else the clamped target (no audio / empty range).
export function refineBoundary(pcm: Pcm | null, targetUs: number, loUs: number, hiUs: number, windowUs = SNAP_WINDOW_US, dbfsFloor = SNAP_DBFS, holdUs = SNAP_HOLD_US, hopUs = HOP_US): number {
  targetUs = Math.max(loUs, Math.min(hiUs, targetUs));
  if (!pcm || pcm.samples.length === 0 || hiUs <= loUs) return targetUs;
  const searchLo = Math.max(loUs, targetUs - windowUs);
  const searchHi = Math.min(hiUs, targetUs + windowUs);
  if (searchHi <= searchLo) return targetUs;

  const hop = Math.max(1, hopUs);
  const floorRms = FULL_SCALE * 10 ** (dbfsFloor / 20);
  const holdHops = Math.max(1, Math.floor(holdUs / hop));
  const hops: [number, number][] = [];
  for (let u = searchLo; u < searchHi; u += hop) hops.push([u, windowRms(pcm.samples, usToIndex(u, pcm.sampleRate), usToIndex(Math.min(u + hop, searchHi), pcm.sampleRate))]);
  if (!hops.length) return targetUs;

  let run = 0;
  for (const [startUs, rms] of hops) {
    if (rms <= floorRms) {
      run++;
      if (run >= holdHops) return Math.max(loUs, Math.min(hiUs, startUs - (run - 1) * hop));
    } else run = 0;
  }
  let best = hops[0];
  for (const h of hops) if (h[1] < best[1]) best = h;
  return Math.max(loUs, Math.min(hiUs, best[0]));
}

const EDGE = 0.03; // a snapped boundary stays ≥ 30 ms inside both words

// Snap every touching or overlapping word pair (gap ≤ 0) to one shared boundary
// in the audio. Pairs with a real gap keep whisper's times. Mutates words and
// records the originals as rawStart/rawEnd. Returns the number of boundaries moved.
export function snapWordBoundaries(words: { start: number; end: number; rawStart?: number; rawEnd?: number }[], pcm: Pcm): number {
  for (const w of words) {
    w.rawStart = w.start;
    w.rawEnd = w.end;
  }
  let moved = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    const rawEnd = a.rawEnd!, rawStart = b.rawStart!;
    if (rawStart - rawEnd > 0) continue;
    const lo = a.start + EDGE, hi = b.rawEnd! - EDGE;
    if (hi <= lo) continue;
    const target = (rawEnd + rawStart) / 2;
    const at = refineBoundary(pcm, Math.round(target * 1e6), Math.round(lo * 1e6), Math.round(hi * 1e6)) / 1e6;
    if (at === a.end && at === b.start) continue;
    a.end = at;
    b.start = at;
    moved++;
  }
  return moved;
}

// ── Quiet regions (Tighten pauses, ADR-004) ─────────────────────────────────
export const QUIET_DBFS = -50; // speech here sits around -35 dBFS (p50); -40 caught quiet speech
export const QUIET_MIN_SEC = 0.3; // shortest region stored; the user's min pause filters further
export const BLIP_SEC = 0.02; // a sound shorter than this (a click) does not end a pause; 60 ms let a soft "if you" through
export const PAUSE_ANALYSIS_VERSION = 3; // bump when detection changes so stored pauses are re-analyzed
const EPS = 1e-9; // float tolerance: a region of exactly minSec is kept wherever it starts

// Stretches of the recording at or below `floorDb`, ignoring loud blips shorter
// than `blipSec`. Audio only by design: whisper stretches words across silence and
// invents words on it ("Thank you."), so the transcript cannot veto a pause.
export function findQuietRegions(pcm: Pcm, floorDb = QUIET_DBFS, minSec = QUIET_MIN_SEC, blipSec = BLIP_SEC): { start: number; end: number }[] {
  const hopSec = HOP_US / 1_000_000;
  const env = envelopeDbfs(pcm);
  const quiet = Array.from(env, (d) => d <= floorDb);
  const blipHops = Math.round(blipSec / hopSec);
  for (let i = 0; i < quiet.length; ) {
    if (quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && !quiet[j]) j++;
    if (j - i < blipHops && i > 0 && j < quiet.length) for (let k = i; k < j; k++) quiet[k] = true;
    i = j;
  }
  const out: { start: number; end: number }[] = [];
  const total = pcm.samples.length / pcm.sampleRate;
  for (let i = 0; i < quiet.length; ) {
    if (!quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    const start = +(i * hopSec).toFixed(3), end = Math.min(total, +(j * hopSec).toFixed(3)); // clamp after rounding
    if (end - start + EPS >= minSec) out.push({ start, end });
    i = j;
  }
  return out;
}

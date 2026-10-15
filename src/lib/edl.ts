import type { Word, Paragraph, PauseSettings } from "./types";

// ── Edit decision list math ─────────────────────────────────────────────────
// Deleted words become time ranges to cut from the source. Ranges are padded
// by half the surrounding inter-word gap (capped), like Descript, so cuts
// don't clip consonants. Overlapping/adjacent ranges merge.

export interface Range {
  start: number;
  end: number;
}

const MAX_PAD = 0.09; // seconds of padding each side
const MIN_CUT = 0.06; // ignore absurdly tiny cuts

export function computeCuts(words: Word[]): Range[] {
  const kept = words.filter((w) => !w.deleted);
  const deleted = words.filter((w) => w.deleted);
  if (deleted.length === 0 || kept.length === 0 && deleted.length === 0) return [];
  if (kept.length === 0) return [{ start: 0, end: Infinity }];

  const raw: Range[] = [];
  for (const w of deleted) {
    // neighbors in time order among ALL words
    const prev = words.filter((x) => x.end <= w.start + 1e-6).pop();
    const next = words.find((x) => x.start >= w.end - 1e-6 && x !== w);
    const leftGap = prev ? Math.min((w.start - prev.end) / 2, MAX_PAD) : 0.02;
    const rightGap = next ? Math.min((next.start - w.end) / 2, MAX_PAD) : 0.02;
    const start = Math.max(0, w.start - leftGap);
    const end = w.end + rightGap;
    if (end - start >= MIN_CUT) raw.push({ start, end });
  }
  raw.sort((a, b) => a.start - b.start);

  const merged: Range[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.001) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// ── Tighten pauses (ADR-004) ──────────────────────────────────────────────────
export const DEFAULT_PAUSES: PauseSettings = { enabled: false, minGap: 1.0, margin: 0.25 };

// Pauses come from the audio alone (findQuietRegions): whisper stretches words
// across silence and invents words on it, so a word inside a pause does not veto it.
export function pauseCuts(words: Word[], pauses: Range[] | undefined, settings: PauseSettings | undefined): Range[] {
  if (!settings?.enabled || !pauses?.length) return [];
  const out: Range[] = [];
  for (const p of pauses) {
    if (p.end - p.start + 1e-9 < settings.minGap) continue; // tolerance: an exact-minGap pause qualifies at any position
    const start = p.start + settings.margin, end = p.end - settings.margin;
    if (end - start + 1e-9 >= MIN_CUT) out.push({ start, end });
  }
  return out;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

// A kept gap this short between two cuts, with no kept word in it, is a sliver
// (a pause margin next to a word cut, or a deleted word too short to cut on its
// own). Measured 2026-10-14: 14 of 80 clips under 0.1 s on a real project.
export const MAX_SLIVER = 0.3;

function closeSlivers(cuts: Range[], words: Word[]): Range[] {
  const out: Range[] = [];
  for (const c of cuts) {
    const last = out[out.length - 1];
    const gapHasSpeech = () => words.some((w) => !w.deleted && Math.min(w.end, c.start) - Math.max(w.start, last.end) > 0.01);
    if (last && c.start - last.end < MAX_SLIVER && !gapHasSpeech()) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

// The one cut list every consumer uses: deleted words plus tightened pauses.
export function deriveCuts(project: { words: Word[]; pauses?: Range[]; tightenPauses?: PauseSettings }): Range[] {
  const words = computeCuts(project.words);
  const pauses = pauseCuts(project.words, project.pauses, project.tightenPauses);
  return closeSlivers(pauses.length ? mergeRanges([...words, ...pauses]) : words, project.words);
}

// Inverse: the segments of the source that survive.
export function computeKeeps(cuts: Range[], total: number): Range[] {
  const keeps: Range[] = [];
  let t = 0;
  for (const c of cuts) {
    const end = Math.min(c.start, total);
    if (end - t > 0.01) keeps.push({ start: t, end });
    t = Math.max(t, c.end);
    if (t >= total) return keeps;
  }
  if (total - t > 0.01) keeps.push({ start: t, end: total });
  return keeps;
}

export function programDuration(cuts: Range[], total: number): number {
  return computeKeeps(cuts, total).reduce((a, k) => a + (k.end - k.start), 0);
}

// Map a source time -> program time (after cuts).
export function sourceToProgram(cuts: Range[], t: number): number {
  let acc = 0;
  for (const c of cuts) {
    if (t <= c.start) return acc + Math.max(0, t);
    if (t < c.end) return acc + c.start; // inside a cut -> lands at its start
    acc -= c.end - c.start;
  }
  return Math.max(0, t + acc);
}

// Map a program time -> source time (for seeking from the transcript).
export function programToSource(cuts: Range[], t: number): number {
  let remaining = t;
  let prevEnd = 0;
  for (const c of cuts) {
    const span = c.start - prevEnd;
    if (remaining <= span) return prevEnd + remaining;
    remaining -= span;
    prevEnd = c.end;
  }
  return prevEnd + remaining;
}

// ── Filler detection ────────────────────────────────────────────────────────
const FILLERS = new Set([
  "um", "uh", "erm", "hmm",
  // "like" is deliberately absent: it cut too many real phrases ("I'd like to", "stuff like that").
  "basically", "actually", "literally", "honestly", "seriously", "obviously",
  "sorta", "kinda",
]);

// Multi-word fillers matched on lowercase token runs.
const PHRASE_FILLERS = [
  ["you", "know"],
  ["i", "mean"],
  ["sort", "of"],
  ["kind", "of"],
  ["at", "the", "end", "of", "the", "day"],
];

const strip = (s: string) => s.toLowerCase().replace(/[^a-z']/g, "");

export function markFillers(words: Word[]): void {
  for (const w of words) w.filler = false;
  const n = words.length;
  for (let i = 0; i < n; i++) {
    const t = strip(words[i].text);
    if (!t) continue;
    if (FILLERS.has(t)) {
      words[i].filler = true;
      continue;
    }
    for (const phrase of PHRASE_FILLERS) {
      let ok = true;
      for (let j = 0; j < phrase.length; j++) {
        if (i + j >= n || strip(words[i + j].text) !== phrase[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (let j = 0; j < phrase.length; j++) words[i + j].filler = true;
        break;
      }
    }
  }
}

// Group words into paragraphs: sentence punctuation ends a paragraph, and so
// does a silence gap longer than gapSec.
export function buildParagraphs(words: Word[], gapSec = 1.4): Paragraph[] {
  const paras: Paragraph[] = [];
  let cur: string[] = [];
  const flush = (idx: number) => {
    if (cur.length) {
      paras.push({ id: `p${paras.length}`, wordIds: cur });
      cur = [];
    }
    void idx;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w.id);
    const next = words[i + 1];
    const ends = /[.!?]["')\]]?$/.test(w.text.trim());
    const gap = next ? next.start - w.end : Infinity;
    if (ends || gap > gapSec) flush(i);
  }
  flush(words.length - 1);
  return paras;
}

// ── SRT export (kept words only) ────────────────────────────────────────────
function srtStamp(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function toSRT(words: Word[], cuts: Range[]): string {
  const kept = words.filter((w) => !w.deleted);
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (let i = 0; i < kept.length; i++) {
    const w = kept[i];
    if (cur.length > 0) {
      const gap = w.start - cur[cur.length - 1].end;
      if (gap > 0.8 || cur.length >= 14) {
        chunks.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);

  const lines: string[] = [];
  chunks.forEach((chunk, i) => {
    const start = sourceToProgram(cuts, chunk[0].start);
    const end = sourceToProgram(cuts, chunk[chunk.length - 1].end);
    lines.push(`${i + 1}`);
    lines.push(`${srtStamp(start)} --> ${srtStamp(Math.max(end, start + 0.4))}`);
    lines.push(chunk.map((w) => w.text).join(" "));
    lines.push("");
  });
  return lines.join("\n");
}

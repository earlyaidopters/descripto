import type { AiRetakes, Word } from "./types";

// ── Repeated takes (Phase 3) ────────────────────────────────────────────────
// Port of capcut's multi-pass detector (my-project/capcut/core/duplicate_detector.py,
// thresholds config.py:160-165, restart phrases config.py:317, ADR-001/066).
// Compares PHRASES, not words: kept words are grouped at pauses and sentence ends.
// The last take always wins; detection only proposes, the user decides (capcut ADR-008:
// "better to miss a bad take than to cut good content").

export const ADJACENT_THRESHOLD = 0.7;
export const WINDOWED_THRESHOLD = 0.65;
export const PREFIX_THRESHOLD = 0.5;
export const WINDOW = 3;
export const SHORT_MAX_WORDS = 3;
export const SHORT_MAX_SEC = 1;
export const SEGMENT_PAUSE_SEC = 0.8; // capcut transcriber.py:208 splits segments at gaps >= 0.8 s
export const SEGMENT_MAX_WORDS = 25; // capcut config.py:358
export const RESTART_PHRASES = ["starting over", "start over", "that didn't work", "that did not work", "this is a retake", "let me redo that", "let me try that again", "scratch that"];

export type RetakeKind = "keyword" | "adjacent" | "windowed" | "prefix" | "short" | "straggler" | "stutter" | "ai";
export interface Segment { wordIds: string[]; text: string; start: number; end: number; }
export interface Retake { bad: Segment; good: Segment; kind: RetakeKind; similarity: number; reason?: string; }

const tokens = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")).filter(Boolean);

// difflib.SequenceMatcher(None, a, b).ratio(): 2*M / (|a|+|b|), M = total size of the
// matching blocks found by recursive longest-common-substring. No autojunk: phrases are <= 25 words.
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const matched = (alo: number, ahi: number, blo: number, bhi: number): number => {
    let bi = alo, bj = blo, size = 0;
    let prev = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const cur = new Map<number, number>();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (prev.get(j - 1) ?? 0) + 1;
        cur.set(j, k);
        if (k > size) { bi = i - k + 1; bj = j - k + 1; size = k; }
      }
      prev = cur;
    }
    if (!size) return 0;
    return size + matched(alo, bi, blo, bj) + matched(bi + size, ahi, bj + size, bhi);
  };
  return (2 * matched(0, a.length, 0, b.length)) / (a.length + b.length);
}

// Group the words that survive into phrases: split after a sentence end, at a pause >=
// SEGMENT_PAUSE_SEC (whisper stretches words over silence, so a pause is assigned to the word
// before its midpoint), and every SEGMENT_MAX_WORDS words. A word whose midpoint lies in a cut
// (e.g. a tightened pause) is skipped: whisper puts invented words on silence, and a phrase that
// is already gone must not be offered as the take to keep.
export function segmentWords(words: Word[], pauses: { start: number; end: number }[] = [], cuts: { start: number; end: number }[] = []): Segment[] {
  const inCut = (w: Word) => { const mid = (w.start + w.end) / 2; return cuts.some((c) => mid >= c.start && mid < c.end); };
  const kept = words.filter((w) => !w.deleted && !inCut(w));
  const breakAfter = new Set<number>();
  for (const p of pauses) {
    if (p.end - p.start + 1e-9 < SEGMENT_PAUSE_SEC) continue;
    const mid = (p.start + p.end) / 2;
    let k = -1;
    for (let i = 0; i < kept.length && (kept[i].start + kept[i].end) / 2 < mid; i++) k = i;
    if (k >= 0) breakAfter.add(k);
  }
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ wordIds: cur.map((w) => w.id), text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  kept.forEach((w, i) => {
    cur.push(w);
    if (/[.?!]["')\]]*$/.test(w.text) || breakAfter.has(i) || cur.length >= SEGMENT_MAX_WORDS) flush();
  });
  flush();
  return out;
}

// One phrase says it and the other denies it ("I like it" / "I don't like it", capcut ADR-001):
// different statements, never a retake.
const NEGATIONS = new Set(["not", "no", "never", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "won't", "can't", "cannot", "shouldn't", "wouldn't"]);
const negated = (t: string[]) => t.some((w) => NEGATIONS.has(w) || w.endsWith("n't"));

// Different figures ("54.5 on the under" / "the under 47.5", "-5" / "5") are different claims,
// not a retake. Read from the original text: token cleanup strips signs and leading points.
// A keeper may ADD figures (a restart that goes on to say "it moved 60 points"); every figure in
// the earlier take must reappear in the keeper.
const figures = (text: string) => (text.match(/[-+]?(?:\d[\d,]*)?\.?\d+/g) ?? []).map((f) => f.replace(/,/g, ""));
const figuresKept = (bad: string[], good: string[]) => { const left = [...good]; return bad.every((f) => { const i = left.indexOf(f); if (i < 0) return false; left.splice(i, 1); return true; }); };

interface Pair { bad: number; good: number; kind: RetakeKind; similarity: number; }

export function detectRetakes(segments: Segment[]): Pair[] {
  const n = segments.length;
  if (n < 2) return [];
  const tok = segments.map((s) => tokens(s.text));
  const fig = segments.map((s) => figures(s.text));
  const compatible = (bad: number, good: number) => negated(tok[bad]) === negated(tok[good]) && figuresKept(fig[bad], fig[good]);
  const best = new Map<number, Pair>();
  const offer = (p: Pair): boolean => {
    if (p.kind !== "keyword" && !compatible(p.bad, p.good)) return false;
    const b = best.get(p.bad);
    if (!b || p.similarity > b.similarity) best.set(p.bad, p);
    return true;
  };
  // Consolidation moves a keeper down a chain; the final pair must pass the same checks.
  const settle = () => {
    consolidate(best);
    for (const [bad, p] of best) if (p.kind !== "keyword" && !compatible(p.bad, p.good)) best.delete(bad);
  };

  // Pass 0: explicit restart phrases mark only the segment that says them.
  for (let i = 0; i + 1 < n; i++) {
    const text = segments[i].text.toLowerCase().replace(/’/g, "'");
    if (RESTART_PHRASES.some((ph) => text.includes(ph))) offer({ bad: i, good: i + 1, kind: "keyword", similarity: 1 });
  }
  // Pass 1: adjacent.
  const seen = new Set<string>();
  for (let i = 0; i + 1 < n; i++) {
    const s = similarity(tok[i], tok[i + 1]);
    if (s >= ADJACENT_THRESHOLD) { seen.add(`${i},${i + 1}`); offer({ bad: i, good: i + 1, kind: "adjacent", similarity: s }); }
  }
  // Pass 2: N vs N+2 .. N+WINDOW.
  for (let i = 0; i < n; i++) for (let j = i + 2; j <= i + WINDOW && j < n; j++) {
    if (seen.has(`${i},${j}`)) continue;
    const s = similarity(tok[i], tok[j]);
    if (s >= WINDOWED_THRESHOLD) offer({ bad: i, good: j, kind: "windowed", similarity: s });
  }
  // Pass 3: N restarts as the opening of a longer N+1.
  let marked = new Set(best.keys());
  for (let i = 0; i + 1 < n; i++) {
    if (marked.has(i)) continue;
    const a = tok[i], b = tok[i + 1];
    if (a.length <= 2 || b.length <= a.length) continue;
    let m = 0;
    while (m < a.length && a[m] === b[m]) m++;
    if (m / a.length >= PREFIX_THRESHOLD) offer({ bad: i, good: i + 1, kind: "prefix", similarity: m / a.length });
  }
  // Pass 4: a short fragment between two connected segments.
  marked = new Set(best.keys());
  for (let i = 1; i + 1 < n; i++) {
    if (marked.has(i) || tok[i].length >= SHORT_MAX_WORDS || segments[i].end - segments[i].start >= SHORT_MAX_SEC) continue;
    const s = similarity(tok[i - 1], tok[i + 1]);
    if (s > 0.4) offer({ bad: i, good: i + 1, kind: "short", similarity: s });
  }
  settle();
  // Pass 5: stragglers similar to a final keeper.
  const keepers = new Set<number>();
  for (const p of best.values()) { let g = p.good; while (best.has(g)) g = best.get(g)!.good; keepers.add(g); }
  for (let i = 0; i < n; i++) {
    if (best.has(i) || keepers.has(i) || tok[i].length < 3) continue;
    for (const g of [...keepers].sort((x, y) => x - y)) {
      if (g <= i) continue;
      const s = similarity(tok[i], tok[g]);
      if (s >= Math.min(WINDOWED_THRESHOLD, 0.55) && offer({ bad: i, good: g, kind: "straggler", similarity: s })) break;
    }
  }
  settle();
  return [...best.values()].sort((a, b) => a.bad - b.bad);
}

// A->B and B->C becomes A->C, B->C. Guarded against cycles (good always > bad, so none arise).
function consolidate(best: Map<number, Pair>) {
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of best.values()) {
      const next = best.get(p.good);
      if (next && next.good !== p.good && next.good > p.bad) { p.good = next.good; changed = true; }
    }
  }
}

// A run of STUTTER_MIN_WORDS+ words said twice back to back ("on top of that every quarterback that
// has faced on top of that every quarterback that has faced Denver") is a restart inside one phrase,
// which the phrase passes cannot see. Searched inside each phrase only; repeats across phrases are
// the phrase passes' job. Spoken number shorthand ("two two two") is never a stutter.
export const STUTTER_MIN_WORDS = 3;
export const STUTTER_MAX_WORDS = 12;
const NUMBER_WORD = /^(\d[\d.,]*|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and|a|half)$/;
const asSegment = (ws: Word[]): Segment => ({ wordIds: ws.map((w) => w.id), text: ws.map((w) => w.text).join(" "), start: ws[0].start, end: ws[ws.length - 1].end });

export function findStutters(kept: Word[]): Retake[] {
  const tok = kept.map((w) => tokens(w.text).join(" "));
  const out: Retake[] = [];
  for (let i = 0; i < kept.length; ) {
    let hit = 0;
    for (let n = Math.min(STUTTER_MAX_WORDS, Math.floor((kept.length - i) / 2)); n >= STUTTER_MIN_WORDS; n--) {
      const a = tok.slice(i, i + n);
      if (a.some((t) => !t) || a.every((t) => NUMBER_WORD.test(t))) continue;
      if (a.every((t, k) => t === tok[i + n + k]) && figuresKept(figures(kept.slice(i, i + n).map((w) => w.text).join(" ")), figures(kept.slice(i + n, i + 2 * n).map((w) => w.text).join(" ")))) { hit = n; break; }
    }
    if (!hit) { i++; continue; }
    out.push({ bad: asSegment(kept.slice(i, i + hit)), good: asSegment(kept.slice(i + hit, i + 2 * hit)), kind: "stutter", similarity: 1 });
    i += hit;
  }
  return out;
}

const keptWords = (words: Word[], cuts: { start: number; end: number }[]) => words.filter((w) => { const mid = (w.start + w.end) / 2; return !w.deleted && !cuts.some((c) => mid >= c.start && mid < c.end); });

export function findRetakes(words: Word[], pauses?: { start: number; end: number }[], cuts: { start: number; end: number }[] = [], ai?: AiRetakes): Retake[] {
  const segs = segmentWords(words, pauses, cuts);
  const out: Retake[] = detectRetakes(segs).map((p) => ({ bad: segs[p.bad], good: segs[p.good], kind: p.kind, similarity: +p.similarity.toFixed(3) }));
  const kept = keptWords(words, cuts);
  const byId = new Map(kept.map((w) => [w.id, w]));
  const claimed = () => new Set(out.flatMap((r) => [...r.bad.wordIds, ...r.good.wordIds]));
  let taken = claimed();
  for (const s of segs.flatMap((g) => findStutters(g.wordIds.map((id) => byId.get(id)!)))) if (!s.bad.wordIds.some((id) => taken.has(id))) out.push(s);
  // AI pairs (ADR-007) were found on an earlier state of the edit: show one only while every word
  // of both takes is still kept, and never over a take the local passes already placed.
  if (ai) {
    taken = claimed();
    for (const p of ai.pairs) {
      const bad = p.badIds.map((id) => byId.get(id)), good = p.goodIds.map((id) => byId.get(id));
      if (!bad.length || !good.length || bad.some((w) => !w) || good.some((w) => !w) || p.badIds.some((id) => taken.has(id))) continue;
      out.push({ bad: asSegment(bad as Word[]), good: asSegment(good as Word[]), kind: "ai", similarity: p.confidence, reason: p.reason });
    }
  }
  return out.sort((a, b) => a.bad.start - b.bad.start);
}

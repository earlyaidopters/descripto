// ── Core data model ─────────────────────────────────────────────────────────
// A project is a directory under projects/<id>/ containing:
//   source.<ext>     the original uploaded media
//   state.json       canonical editing state (this file's types)
//   renders/         rendered cuts
//   review.json      latest Gemini watch-back review
//   audit.json       latest Haiku transcript audit

export interface Word {
  id: string; // stable id, e.g. "w17"
  text: string; // token as transcribed (may carry punctuation)
  start: number; // seconds in the SOURCE media
  end: number; // seconds in the SOURCE media
  deleted: boolean; // true = this word is cut from the program
  confidence?: number; // 0..1 from the ASR engine, when available
  filler?: boolean; // detected filler word
  rawStart?: number; // ASR start before the audio-envelope snap (ADR-003)
  rawEnd?: number; // ASR end before the audio-envelope snap (ADR-003)
}

export interface Paragraph {
  id: string; // "p0", "p1", ...
  wordIds: string[]; // ordered
}

export interface ProjectState {
  id: string;
  name: string;
  createdAt: string;
  sourceFile: string; // absolute path
  sourceDuration: number; // seconds
  sourceWidth?: number;
  sourceHeight?: number;
  transcribed: boolean;
  transcriptEngine?: string; // which ASR produced `words` (groq/... or local whisper)
  words: Word[];
  paragraphs: Paragraph[];
  studioSound: boolean; // apply audio enhancement on render
  pauses?: { start: number; end: number }[]; // quiet stretches of the audio (ADR-004), from audio16k.wav
  pausesVersion?: number; // detection version that produced `pauses`
  tightenPauses?: PauseSettings; // "Tighten pauses" setting; absent = off
  lastRender?: RenderInfo;
  lastReview?: ReviewReport;
  lastAudit?: AuditReport;
  aiRetakes?: AiRetakes; // last "AI check" for repeated takes (ADR-007); word ids, re-validated on read
}

export interface AiRetakePair { badIds: string[]; goodIds: string[]; confidence: number; reason: string; }
export interface AiRetakes { at: string; model: string; pairs: AiRetakePair[]; }

export interface PauseSettings {
  enabled: boolean;
  minGap: number; // seconds; only pauses at least this long are tightened
  margin: number; // seconds of the pause kept on each side
}

export interface RenderInfo {
  cuts?: { start: number; end: number }[];
  file: string; // absolute path of rendered mp4
  duration: number; // program duration after cuts
  renderedAt: string;
  studioSound: boolean;
  cutCount: number;
}

export interface ReviewIssue {
  timestamp: number; // seconds into the rendered program
  severity: "info" | "warning" | "error";
  kind: string; // e.g. "jump-cut", "audio-glitch", "pacing"
  note: string;
}

export interface ReviewReport {
  model: string;
  reviewedFile: string;
  summary: string;
  overall: string; // Gemini's free-text overall verdict
  issues: ReviewIssue[];
  reviewedAt: string;
}

export interface AuditCorrection {
  wordId: string;
  current: string;
  suggested: string;
  reason: string;
  confidence: number; // 0..1, Haiku's confidence the fix is right
  applied?: boolean; // once accepted
}

export interface AuditReport {
  model: string;
  corrections: AuditCorrection[];
  notes: string;
  auditedAt: string;
}

export interface RenderJob {
  id: string;
  projectId: string;
  status: "queued" | "running" | "cancelling" | "cancelled" | "done" | "error";
  progress: number; // 0..100
  stage: string;
  output?: string;
  error?: string;
  startedAt: number;
}

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

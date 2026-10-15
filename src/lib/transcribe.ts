import fs from "fs";
import { spawn } from "child_process";
import type { Word } from "./types";
import { extractAudio } from "./ffmpeg";
import { runProcess } from "./subprocess";
import { groqKey } from "./env";
import { findQuietRegions, PAUSE_ANALYSIS_VERSION, readWav, snapWordBoundaries } from "./audio-envelope";
export { PAUSE_ANALYSIS_VERSION };
const run = (bin: string, args: string[]) => runProcess(bin, args);

// ── Transcription ───────────────────────────────────────────────────────────
// Primary: Groq whisper-large-v3-turbo (fast, word-level timestamps).
// Fallback: local OpenAI whisper CLI with --word_timestamps.

export interface TranscribeResult {
  words: Word[];
  engine: string;
  pauses?: { start: number; end: number }[]; // quiet stretches of the audio (ADR-004)
  pausesVersion?: number;
}

interface RawWord {
  word: string;
  start: number;
  end: number;
}

// Groq rejects uploads over 25 MB (HTTP 413). The 16 kHz mono WAV used by local
// whisper is ~2 MB per minute, so anything past ~13 minutes silently fell back
// to the slow local engine. A 48 kbps mono MP3 is ~0.36 MB per minute, which
// keeps a 70-minute recording under the cap.
export const GROQ_UPLOAD_LIMIT = 25 * 1024 * 1024;
export async function compressForUpload(wav: string, out = wav.replace(/\.wav$/, "") + ".upload.mp3"): Promise<string> {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", out]);
  return out;
}

async function transcribeGroq(wav: string): Promise<{ words: RawWord[]; text: string }> {
  const key = groqKey();
  if (!key) throw new Error("Add a Groq API key in Settings → Connections, or install local Whisper.");
  const upload = await compressForUpload(wav);
  let buf: Buffer;
  try { buf = fs.readFileSync(upload); } finally { try { fs.unlinkSync(upload); } catch {} }
  if (buf.length > GROQ_UPLOAD_LIMIT) throw new Error(`audio is ${(buf.length / 1048576).toFixed(0)} MB after compression; Groq accepts at most 25 MB`);
  const boundary = "----frm" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
    language: "en",
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  void meta;
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const rawWords: RawWord[] = (j.words || []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
  return { words: rawWords, text: j.text || "" };
}

function transcribeLocal(wav: string): Promise<{ words: RawWord[]; text: string }> {
  return new Promise((resolve, reject) => {
    const outDir = wav + ".out";
    fs.mkdirSync(outDir, { recursive: true });
    const p = spawn(process.env.LOCAL_WHISPER_BIN || "whisper", [
      wav,
      "--model", process.env.LOCAL_WHISPER_MODEL || "small",
      "--task", "transcribe",
      "--language", "en",
      "--word_timestamps", "True",
      "--output_format", "json",
      "--output_dir", outDir,
    ]);
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`local whisper exited ${code}: ${stderr.slice(-1500)}`));
      try {
        const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json"));
        if (!files.length) return reject(new Error("local whisper produced no json"));
        const j = JSON.parse(fs.readFileSync(`${outDir}/${files[0]}`, "utf-8"));
        const rawWords: RawWord[] = [];
        for (const seg of j.segments || []) {
          for (const w of seg.words || []) {
            rawWords.push({ word: w.word, start: w.start, end: w.end });
          }
        }
        resolve({ words: rawWords, text: j.text || "" });
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

function normalizeWords(raw: RawWord[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    let text = (w.word || "").trim();
    if (!text) continue;
    // Skip whisper's bracketed annotations like [BLANK_AUDIO]
    if (/^\[.*\]$/.test(text)) continue;
    let start = Number(w.start);
    let end = Number(w.end);
    if (!isFinite(start) || !isFinite(end)) continue;
    if (end < start) [start, end] = [end, start];
    if (end - start < 0.01) end = start + 0.08;
    out.push({ id: `w${out.length}`, text, start, end, deleted: false });
  }
  return out;
}

// Snap shared word boundaries into the audio (ADR-003) and find its quiet
// stretches (ADR-004). A WAV we cannot read leaves whisper's timestamps as they
// are and no pauses; transcription still succeeds.
function withAudio(words: Word[], wav: string, engine: string): TranscribeResult {
  try {
    const pcm = readWav(wav);
    snapWordBoundaries(words, pcm);
    return { words, engine, pauses: findQuietRegions(pcm), pausesVersion: PAUSE_ANALYSIS_VERSION };
  } catch (e) {
    console.warn(`[transcribe] envelope snap skipped: ${(e as Error).message}`);
    return { words, engine };
  }
}

// Quiet stretches for a project analyzed by an older detector (or none); null when the WAV is unusable.
export function pausesFromWav(wav: string): { start: number; end: number }[] | null {
  try {
    return findQuietRegions(readWav(wav));
  } catch (e) {
    console.warn(`[pauses] could not analyze ${wav}: ${(e as Error).message}`);
    return null;
  }
}

export async function transcribe(source: string, workDir: string): Promise<TranscribeResult> {
  const wav = `${workDir}/audio16k.wav`;
  await extractAudio(source, wav);
  const errors: string[] = [];
  try {
    const r = await transcribeGroq(wav);
    if (r.words.length > 0) return withAudio(normalizeWords(r.words), wav, "groq/whisper-large-v3-turbo");
    errors.push("groq returned 0 words");
  } catch (e) {
    errors.push(`groq: ${(e as Error).message}`);
  }
  console.warn(`[transcribe] Groq unavailable, falling back to local whisper: ${errors.join("; ")}`);
  try {
    const r = await transcribeLocal(wav);
    if (r.words.length > 0) return withAudio(normalizeWords(r.words), wav, `local whisper (${process.env.LOCAL_WHISPER_MODEL || "small"})`);
    errors.push("local whisper returned 0 words");
  } catch (e) {
    errors.push(`local: ${(e as Error).message}`);
  }
  throw new Error(`All transcription engines failed: ${errors.join(" | ")}`);
}

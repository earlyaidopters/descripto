import { runProcess } from "./subprocess";
import fs from "fs";
import path from "path";
import type { Range } from "./edl";

// ── ffmpeg helpers ──────────────────────────────────────────────────────────

export interface Probe {
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  frameRate?: number;
}

function parseRate(r?: string): number | undefined {
  if (!r) return undefined;
  const [num, den] = r.split("/").map(Number);
  if (!isFinite(num) || !num) return undefined;
  const rate = den ? num / den : num;
  return isFinite(rate) && rate > 0 ? rate : undefined;
}

export async function probe(file: string, signal?: AbortSignal): Promise<Probe> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file];
  const { stdout } = await run("ffprobe", args, signal);
  const j = JSON.parse(stdout);
  const streams: any[] = j.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  let duration = parseFloat(j.format?.duration || "0");
  if (!isFinite(duration)) duration = parseFloat(v?.duration || "0") || 0;
  return {
    duration,
    width: v?.width,
    height: v?.height,
    hasAudio: !!a,
    hasVideo: !!v,
    frameRate: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate),
  };
}

function run(bin: string, args: string[], signal?: AbortSignal) {
  return runProcess(bin, args, { signal });
}

// Render the program: keep `keeps` ranges, optionally apply Studio Sound.
// Single-pass filter_complex. Video is ONE stream: fps normalises to a constant
// frame rate, select keeps frames whose timestamp falls in a kept range
// (half-open, so a boundary frame is never kept twice), setpts closes the gaps.
// Audio is trimmed per range with atrim (sample-accurate) and concatenated,
// then the optional polish chain runs. The earlier graph fanned [0:v] out into
// one trim branch per range and concatenated them; ffmpeg retains the decoded
// frames queued on every branch concat has not reached yet, so memory grew
// with the uncompressed program (4.8 GB in 16 s on an 81-range 1080p export,
// which took the whole machine down). Audio branches cost a few hundred MB at
// most, which is why they still use trim/concat. Progress is parsed from
// ffmpeg's -progress pipe.
export function renderFilterGraph(
  keeps: Range[],
  opts: { studioSound: boolean; hasAudio: boolean; frameRate?: number },
): { filter: string; maps: string[] } {
  const n = keeps.length;
  if (n === 0) throw new Error("Nothing to keep — every word is deleted");
  const filters: string[] = [];
  const keepExpr = keeps.map(k => `gte(t\\,${k.start.toFixed(3)})*lt(t\\,${k.end.toFixed(3)})`).join("+");
  const video = [opts.frameRate ? `fps=${opts.frameRate.toFixed(3)}` : "", `select='${keepExpr}'`, "setpts=N/FRAME_RATE/TB"].filter(Boolean).join(",");
  filters.push(`[0:v]${video}[vout]`);
  let maps = ["-map", "[vout]"];
  if (opts.hasAudio) {
    for (let i = 0; i < n; i++) {
      filters.push(`[0:a]atrim=start=${keeps[i].start.toFixed(3)}:end=${keeps[i].end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    }
    const audioInputs = keeps.map((_, i) => `[a${i}]`).join("");
    const chain = opts.studioSound
      ? `highpass=f=70,afftdn=nf=-25,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=200,loudnorm=I=-14:TP=-1.5:LRA=11`
      : "anull";
    filters.push(`${audioInputs}concat=n=${n}:v=0:a=1,${chain}[aout]`);
    maps = maps.concat(["-map", "[aout]"]);
  }
  return { filter: filters.join(";"), maps };
}

export function renderProgram(
  source: string,
  out: string,
  keeps: Range[],
  opts: { studioSound: boolean; hasAudio: boolean; total: number; frameRate?: number; signal?: AbortSignal },
  onProgress: (frac: number, stage: string) => void,
): Promise<void> {
  let graph: { filter: string; maps: string[] };
  try { graph = renderFilterGraph(keeps, opts); } catch (error) { return Promise.reject(error); }

  const args = [
    "-y",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-nostats",
    "-i", source,
    "-filter_complex", graph.filter,
    ...graph.maps,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-t", String(opts.total),
    "-movflags", "+faststart",
    out,
  ];

  return runProcess("ffmpeg", args, { signal: opts.signal, onStdout: s => {
    const m = s.match(/out_time_ms=(\d+)/);
    if (m && !opts.signal?.aborted) onProgress(Math.min(0.99, Number(m[1]) / 1000000 / Math.max(0.1, opts.total)), "Encoding");
  }}).then(() => { onProgress(1, "Done"); });
}

// Extract a mono 16k wav for transcription.
export async function extractAudio(source: string, out: string): Promise<void> {
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out]);
}

export function fileSize(f: string): number {
  return fs.statSync(f).size;
}

export function ensureDir(d: string): string {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function withExt(f: string, ext: string): string {
  return path.join(path.dirname(f), path.basename(f, path.extname(f)) + ext);
}

export async function extractFinishingAudio(video: string, output: string, signal?: AbortSignal) {
  await run("ffmpeg", ["-y", "-i", video, "-vn", "-c:a", "flac", output], signal);
}
export async function replaceAudio(video: string, audio: string, output: string, duration: number, signal?: AbortSignal) {
  await run("ffmpeg", ["-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-af", "apad", "-t", String(duration), "-movflags", "+faststart", output], signal);
}

import { setTimeout as delay } from "timers/promises";
import fs, { openAsBlob } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { extractFinishingAudio, replaceAudio, probe } from "./ffmpeg";

const API = "https://auphonic.com/api";
interface Production {
  uuid: string; status?: number; status_string?: string; error_status?: string | number | null; error_message?: string;
  output_files?: { format: string; download_url: string }[];
}
async function request(endpoint: string, key: string, init: RequestInit = {}): Promise<Production> {
  let response: Response;
  try { response = await fetch(`${API}${endpoint}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers }, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000), redirect: "error" }); }
  catch { init.signal?.throwIfAborted(); throw new Error("Auphonic could not be reached. Check your connection and try again."); }
  if (!response.ok) throw new Error(`Auphonic returned HTTP ${response.status}. Check your connection, API key and account credits in Settings.`);
  const body = await response.json();
  if (body.error_code || body.status_code !== 200 || !body.data) throw new Error("Auphonic could not process this request. Check your account and credits.");
  return body.data;
}
// Deliberately avoid presets: a user's preset may cut silence or add an intro,
// which would desynchronize the finished audio from the edited video.
// Auphonic serves finished files from its own hosts or, since October 2026,
// from a pre-signed Cloudflare R2 bucket (<account>.r2.cloudflarestorage.com).
// The bearer token is only ever sent to auphonic.com; the R2 link carries its
// own signature in the query string.
export function trustedDownloadHost(hostname: string): boolean {
  return hostname === "auphonic.com" || hostname.endsWith(".auphonic.com") || /^[a-z0-9]+\.r2\.cloudflarestorage\.com$/.test(hostname);
}

export async function processAuphonicAudio(input: string, output: string, key: string, onStage: (stage: string) => void, options: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (!key) throw new Error("Add your Auphonic key in Settings → Connections before rendering.");
  const signal = options.signal;
  signal?.throwIfAborted();
  onStage("Creating Auphonic production");
  const created = await request("/productions.json", key, {
    signal, method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata: { title: "Descripto audio finishing" }, output_files: [{ format: "flac" }],
      algorithms: { filtering: true, leveler: true, normloudness: true, loudnesstarget: -16, maxpeak: -1, denoise: true, silence_cutter: false, filler_cutter: false, cough_cutter: false, music_cutter: false }, outgoing_services: [] }),
  });
  if (!/^[a-zA-Z0-9]{22}$/.test(created.uuid)) throw new Error("Auphonic returned an invalid production ID.");
  const endpoint = `/production/${created.uuid}`;
  try {
  signal?.throwIfAborted();
  onStage("Uploading audio to Auphonic");
  const form = new FormData();
  form.append("input_file", await openAsBlob(input, { type: "audio/flac" }), "descripto-audio.flac");
  await request(`${endpoint}/upload.json`, key, { method: "POST", body: form, signal });
  await request(`${endpoint}/start.json`, key, { method: "POST", signal });
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
  let result: Production | undefined;
  while (Date.now() < deadline) {
    const status = await request(`${endpoint}/status.json`, key, { signal });
    if (status.error_status || status.error_message || /error|failed|cancelled|stopped/i.test(status.status_string || "")) throw new Error("Auphonic processing failed. Open your Auphonic account to inspect the production.");
    if (status.status === 3) { result = await request(`${endpoint}.json`, key, { signal }); break; }
    onStage("Auphonic is finishing your audio");
    await delay(options.pollMs ?? 3000, undefined, { signal });
  }
  if (!result) throw new Error("Auphonic is taking longer than expected. Check your Auphonic account before retrying; the production may still be running.");
  const file = result.output_files?.find(f => f.format === "flac");
  if (!file) throw new Error("Auphonic did not return the expected audio file.");
  let url = new URL(file.download_url);
  if (url.protocol !== "https:" || url.hostname !== "auphonic.com" || !url.pathname.startsWith("/api/download/")) throw new Error("Auphonic returned an unexpected download address.");
  onStage("Downloading finished audio");
  // Auphonic documents token-in-query downloads and redirects to its media hosts.
  // Never log this URL or carry credentials to an unrelated domain.
  url.searchParams.set("bearer_token", key);
  let download: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    download = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000), redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(download.status)) break;
    const location = download.headers.get("location");
    if (!location) throw new Error("Auphonic returned an incomplete download redirect.");
    const next = new URL(location, url);
    if (next.protocol !== "https:" || !trustedDownloadHost(next.hostname) || next.username || next.password) throw new Error("Auphonic returned an unexpected download redirect.");
    url = next;
  }
  if (!download?.ok || !download.body) throw new Error("Could not download the finished audio from Auphonic.");
  await pipeline(Readable.fromWeb(download.body as any), fs.createWriteStream(output, { mode: 0o600 }), { signal });
  } catch (error) {
    if (signal?.aborted) {
      // Stop only the production created for this export. Use a fresh bounded
      // signal: the export signal is already aborted.
      try { await request(`${endpoint}/stop.json`, key, { method: "POST", signal: AbortSignal.timeout(5000) }); }
      catch { throw new Error("Local export stopped, but Auphonic could not confirm cancellation. Check this production in your Auphonic account."); }
      signal.throwIfAborted();
    }
    throw error;
  }
}
export async function finishWithAuphonic(video: string, key: string, onStage: (stage: string) => void, signal?: AbortSignal) {
  const source = `${video}.input.flac`, cleaned = `${video}.finished.flac`, muxed = `${video}.finished.mp4`;
  try {
    onStage("Preparing audio for Auphonic");
    await extractFinishingAudio(video, source, signal);
    await processAuphonicAudio(source, cleaned, key, onStage, { signal });
    const [before, after] = await Promise.all([probe(video, signal), probe(cleaned, signal)]);
    if (Math.abs(before.duration - after.duration) > 0.25) throw new Error("Auphonic changed the audio duration. Export stopped to preserve video sync.");
    onStage("Combining finished audio and video");
    await replaceAudio(video, cleaned, muxed, before.duration, signal);
    signal?.throwIfAborted();
    fs.renameSync(muxed, video);
  } finally { for (const file of [source, cleaned, muxed]) { try { fs.unlinkSync(file); } catch {} } }
}

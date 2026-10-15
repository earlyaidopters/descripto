# ADR-001: Single-stream export graph, bounded provider uploads, Auphonic download hosts

**Status:** Accepted
**Date:** 2026-10-13
**Authors:** Carlos
**Project:** descripto

## Context

The first real export (17-minute 1080p30 source, 80 word-level cuts) froze the whole
laptop: the WSL VM consumed its 24 GB allotment, Chrome died, and the machine had to be
restarted by hand. `renderProgram` built one `trim` branch per kept range off `[0:v]` and
fed all 81 into a video `concat`; ffmpeg retains the decoded frames queued on every branch
concat has not reached yet, so memory tracked the uncompressed program. Reproduced under
`ulimit -v 6000000`: 4.78 GB resident after 16 s, "Cannot allocate memory" at 47 s of output.

Two provider limits surfaced the same evening. Groq rejects uploads over 25 MB (HTTP 413);
the 16 kHz mono WAV the app sent is ~2 MB/min, so anything past ~13 minutes silently fell
back to the slow local whisper with no indication in the UI. Auphonic now redirects finished
downloads to a pre-signed Cloudflare R2 URL, which the host allowlist (`*.auphonic.com` only)
refused, discarding the export.

## Decision

1. **Video is one filter chain.** `renderFilterGraph` emits
   `[0:v]fps=<avg_frame_rate>,select='gte(t,a)*lt(t,b)+…',setpts=N/FRAME_RATE/TB[vout]`.
   Ranges are half-open so a boundary frame is never kept twice. Audio keeps sample-accurate
   per-range `atrim` + `concat` (bounded: a few hundred MB for a 17-minute program).
   `probe` now reports `frameRate` and the render route passes it through.
2. **Groq receives a compressed upload.** `compressForUpload` transcodes the WAV to 48 kbps
   mono MP3 (~0.36 MB/min, ~70 minutes under the cap), deletes it after the request, and
   refuses with a clear message if still over `GROQ_UPLOAD_LIMIT`. A fallback to local
   whisper is logged with the Groq error.
3. **The transcript engine is persisted** (`ProjectState.transcriptEngine`) and shown under
   the script title, so a silent fallback is visible.
4. **Auphonic download redirects** may target `auphonic.com`, `*.auphonic.com`, or
   `<alnum>.r2.cloudflarestorage.com` (anchored regex). The bearer token is only ever sent to
   auphonic.com; the R2 link carries its own signature.
5. **Operating decision:** Auphonic's free plan stamps a 6.4 s jingle at each end of every
   production ("Productions of free users come with a jingle", auphonic.com/pricing), which
   the app's duration guard correctly rejects. Purchased credits remove it (verified: a 60 s
   slice returned 60.000 s after purchase, 66.409 s before). The guard stays.

## Consequences

- Full 17-minute export: 2.86 GB peak, 237 s, video/audio durations within one frame.
  Verified live at 02:20Z with Auphonic finishing (1018.967 s / 1018.966 s).
- The memory blow-up itself is guarded only by the filter-string shape test; the real-render
  test uses a 128x72 clip and cannot reproduce the queueing. Evaluated and accepted: a
  long-source memory test is too slow for the suite.
- The editor's "Transcribed by …" label has no test (UI string; evaluated and declined as
  placebo coverage).
- `scripts/faster-whisper-cli.py` (untracked local fallback) has no tests; out of scope.
- The 17-minute synthetic WAV in `tests/transcribe-upload.cjs` adds ~10 s to the suite.

## Tests

CI (`.github/workflows/ci.yml`) runs `pnpm test` on push and PR. Suite: 31 tests, 31 pass.
Mutation-tested by a fresh agent on 2026-10-13; all production files restored and checked
with `sha256sum -c`:

| Contract | Test | Mutation reintroduced | Result |
|---|---|---|---|
| One video chain | `tests/render-audio.cjs` "video is rendered as one stream…" | per-range `[0:v]trim` + `concat=n=N:v=1` | 31 run / 1 fail, caught |
| Half-open ranges, fps, setpts | same test | `lt`→`lte`; drop `fps=`; `setpts=N/FRAME_RATE/TB`→`PTS-STARTPTS` | caught (setpts caught after assertion tightened) |
| A/V length with many cuts | `tests/render-audio.cjs` "many cuts keep audio and video the same length" | n/a (duration contract) | passes |
| Compressed upload under cap | `tests/transcribe-upload.cjs` | return WAV uncompressed; `48k`→`320k`; stereo | 31 run / 1 fail each, caught |
| Redirect host allowlist | `tests/connections.cjs` "Auphonic follows media-host redirects…" | unanchored regex; drop `$`; `endsWith`→`includes` | caught (`includes` caught after a `notauphonic.com` case was added) |

## Alternatives Considered

- Per-segment `-ss/-to` encodes joined by the concat demuxer: more decoding, intermediate
  files, and an audio join step; rejected.
- `select`/`aselect` for both streams: `aselect` picks whole audio frames, so 80 cuts drift
  A/V by up to a frame each; rejected in favour of sample-accurate `atrim`.
- Trim/concat with an explicit `split` and queue limits: ffmpeg offers no general queue
  limit for this topology; rejected.
- Dropping the Auphonic duration guard to accept the jingle: would ship out-of-sync video;
  rejected.

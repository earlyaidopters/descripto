# ADR-003: Snap shared word boundaries to the audio envelope at transcription time

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

ADR-002 rejected two transcript-only padding rules and named an audio snap as the next step.
Groq whisper returns contiguous word spans: on the latest project (1471 words) the live
`state.json` has **1358 exact-zero gaps and 31 overlaps out of 1470** (ADR-002 quoted 1373 zero
gaps from an earlier sweep; the conclusion is unchanged, but overlaps also have to be handled).
With no gap, the boundary between a filler and its kept neighbour is whisper's guess, and
`computeCuts` cuts exactly there.

## Decision

`transcribe()` reads the 16 kHz mono PCM16 WAV it already extracts (`src/lib/audio-envelope.ts`)
and, for every consecutive pair whose original gap is **<= 0**, moves `a.end` and `b.start` to one
shared point found in the audio. The search is a port of capcut's `refine_boundary`
(`my-project/capcut/core/audio_analysis.py:145`, capcut ADR-030): target = midpoint of the pair's
raw touch/overlap, window +/-150 ms clamped to `[a.start + 30 ms, b.end - 30 ms]`, onset of the
first >= 60 ms run at or below -40 dBFS on 10 ms hops, else the quietest hop, else the target.

- Pairs with a real gap (> 0) keep whisper's times.
- The original times are kept on each word as optional `rawStart` / `rawEnd`.
- A WAV that is missing, unsupported (not PCM mono 16-bit 16 kHz), truncated or odd-length
  throws inside `parseWav`; `transcribe()` warns (`[transcribe] envelope snap skipped`) and keeps
  whisper's times. Transcription never fails because of the snap.
- `computeCuts` is unchanged; it pads off the snapped boundaries as before.

## Consequences

- Gaps stay exactly 0 by construction (one shared point), so "gap p50 > 0" is not a success
  measure; the measure is boundaries moved and by-ear clipping.
- Total cut for the 25 fillers drops 7.38 s -> 6.73 s on the latest project: the snap returns the
  onset of silence, so a filler on the left side of a pair loses the pause after it. Heard as
  clean; revisit only if pauses after removed fillers sound long.
- The snap runs once at transcription. Existing projects keep their old timestamps until
  re-transcribed.
- Applies to every engine path (Groq and local whisper).
- Not tested: `transcribe()`'s warn-and-continue path (`snapToAudio` is private and the function
  shells out to ffmpeg/Groq); verified by code read only.
- The guard runs in CI: `ci.yml` runs `pnpm test`, which includes `tests/envelope.cjs`.

## Evidence

- New project `pmv8bmero5904aa` from the same source: `POST /api/projects/pmv8bmero5904aa/transcribe
  200 in 10038ms`, 1471 words. Raw: 1358 zero gaps, 31 overlaps. Snapped: 0 overlaps, 1349
  boundaries moved, |shift| p50 80 ms / p90 150 ms / max 310 ms; no positive-gap pair changed.
- Export with the 25 fillers deleted, Studio Sound on: 23 cuts, `lastRender.duration`
  660.266667 s, `ffprobe` 660.266667 s. Carlos listened to all 23 cut points: "sounds good".
- Independent read-only review: port matches the Python line by line; no overlap or
  sub-30 ms word on the live data beyond float noise at the 30 ms floor.
- Astra review loop (think low): round 1 NOT CLEAN (a truncated WAV was read as silence, fixed in
  `07cebb6`); round 2 CLEAN.

## Tests

`tests/envelope.cjs`, 12 tests; full suite `node --no-experimental-strip-types --test tests/*.cjs`
under Node 24: 43 pass / 0 fail. Mutation-tested by a separate agent, each mutation restored and
sha256-verified:

| Mutation (`src/lib/audio-envelope.ts`) | Caught |
|---|---|
| drop the chunk pad byte `(size & 1)` | yes |
| truncation check `size > buf.length - body` -> `size > buf.length` | yes |
| drop `fmt.format !== 1` / `fmt.bits !== 16` | yes / yes |
| onset `startUs - (run - 1) * hop` -> `startUs` | yes |
| remove the initial target clamp | yes |
| `SNAP_HOLD_US` 60 000 -> 30 000 | yes |
| `rms <= floorRms` -> `<` | yes |
| gap condition `> 0` -> `>= 0` | yes |
| `EDGE` 0.03 -> 0 | yes |
| target midpoint -> `rawEnd` | yes (re-run by the author) |

The final clamp in the quietest-hop fallback survives mutation because it is unreachable (every
hop starts inside `[searchLo, searchHi)`, already inside `[lo, hi]`); it stays as defensive code.

## Alternatives Considered

- Transcript-only padding rules: rejected in ADR-002 (starved filler cuts).
- Splitting each pair into a real gap (voice offset / voice onset): would give `computeCuts`'
  half-gap pad room to work, but goes beyond the agreed design; the shared point was heard as
  clean.

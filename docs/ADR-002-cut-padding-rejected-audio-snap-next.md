# ADR-002: Cut padding cannot fix word clipping; snap cut edges to audio energy instead

**Status:** Accepted (padding rules REJECTED; audio snap is the next step, not yet built)
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

Exports clipped the beginnings and endings of *kept* words next to deleted fillers.
`computeCuts` (`src/lib/edl.ts`) pads each deleted word outward by half the inter-word gap,
capped at 90 ms, and the render path applies the EDL exactly (ADR-001).

Two transcript-only replacements were tried the same day and both rejected on the real
project (`projects/<latest>/state.json`, 1471 words, 25 fillers = 7.28 s raw):

| Rule | Total cut on the project | Verdict |
|---|---|---|
| Original outward half-gap pad (≤ 90 ms) | 7.38 s | clips neighbours (reported by ear) |
| capcut-style fixed 125 ms inward margin, fused runs (`xml_cut.py`) | 3.14 s | starves single-word deletions |
| 125 ms guard from the kept neighbour's timestamp | 2.50 s | starves even harder |

The measurement that settled it: **1373 of 1470 inter-word gaps are exactly 0.** Groq/whisper
returns contiguous spans (`word.end == next.start`). There is no gap to protect; the boundary
between a filler and its neighbour is a guess that frequently lands inside the neighbour. Any
rule that reasons from timestamps alone either clips (cut the span as given) or removes almost
nothing (back off from the span). capcut hit the identical wall and resolved it with an
audio-energy snap (`capcut/config.py:188-195`, ADR-030/031), not with padding.

## Decision

1. Keep the original `computeCuts` rule unchanged. Filler removal stays at full strength.
2. The next lever is **snapping each cut edge to the local RMS minimum within ±150 ms** of the
   transcript boundary, using the project's existing `audio16k.wav`. Snap at transcription
   time and store the refined boundaries on the `Word` (so `computeCuts`, playback and the
   client stay audio-free), or as a `snapStart`/`snapEnd` pair if the raw timestamps must
   survive for the transcript view. Not built in this session; handoff in
   `~/.claude/plans/next-session-descripto-audio-snap-and-silence.md`.
3. Silence removal shares the same conclusion: with zero-gap transcripts a gap threshold finds
   nothing, so it must read the audio envelope too. Build the envelope once for both.

## Consequences

- No behaviour change ships from this ADR; it records the rejected approaches so they are not
  retried. The 125 ms-margin commit (`649ea7c`) is reverted by the following commit.
- Astra review loop on the margin rule reached CLEAN (R1: float-rounding drop in the min-cut
  check, fixed; R2: CLEAN). The review was correct about the code and blind to the data; the
  project-level measurement is what rejected it. Measure on the real transcript first next time.
- Auphonic's hosted `silence_cutter` remains excluded (ADR-001 s5 duration guard).

## Evidence

Gap sweep: `node -e` over `state.json`, all-gap quantiles p10/p50/p90 = 0.000/0.000/0.000;
per-filler `gapL`/`gapR` columns all 0.00 or negative. Suite after revert (Node 24):
`node --no-experimental-strip-types --test tests/*.cjs` -> tests 31 / pass 31 / fail 0;
`npx tsc --noEmit -p .` exit 0.

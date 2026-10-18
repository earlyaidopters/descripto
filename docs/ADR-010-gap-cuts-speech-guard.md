# ADR-010: Gap cuts with a speech guard — Auto Cut's polarity joins Tighten pauses

**Status:** Accepted
**Date:** 2026-10-17
**Authors:** Carlos, Claude
**Project:** descripto

## Context

Carlos: Tighten pauses left long dead-air stretches in the export that Auto Cut (capcut) removes.
Measured on `pmvckyq2lea76f9`: a 13.14 s span between kept words (67.20–80.34) is breath and room
noise peaking −39 to −45 dBFS. The ADR-005 detector requires proof of quiet (≤ −50 dBFS), so those
breaths fragment the span into ~8 regions; five fall under the 1.0 s `minGap` and each is skipped
on its own. ~3.6 s of dead air survived. An occupancy-clustering prototype gained only 2.16 s at a
safe threshold — structurally unable to fix this.

capcut solved the same problem with the opposite polarity (capcut ADR-033): a transcript gap is cut
whole unless its interior holds a **sustained speech-level run** (≥ 200 ms above −35 dBFS,
`longest_loud_run_us`). Breaths never sustain 200 ms above −35, so they cannot save a gap.

## Decision

- `findSpeechRuns` (`src/lib/audio-envelope.ts`): port of capcut's detector — maximal runs of 40 ms
  hops above `SPEECH_DBFS` (−35) lasting ≥ `SPEECH_HOLD_SEC` (0.2). Stored on the project as
  `speech`, produced at transcribe alongside `pauses`; `PAUSE_ANALYSIS_VERSION` bumped to 4 so
  existing projects are re-analyzed (both fields) on the next GET.
- `gapCuts` (`src/lib/edl.ts`): when Tighten pauses is enabled, every gap between kept words
  (plus the lead-in from 0 and, when `sourceDuration` is known, the tail) of at least `minGap` is
  cut, keeping `margin` each side — **unless** speech runs overlapping the gap total more than
  `GAP_SPEECH_TOLERANCE` (0.05 s) after subtracting overlap with **deleted** word spans. A deleted
  false-start explains its own loud run; unexplained sustained sound is a possible transcription
  hole and the gap stays whole (capcut ADR-033's safe failure: an un-shortened pause, never
  beheaded speech).
- `deriveCuts` merges word cuts + pause cuts (ADR-005, unchanged) + gap cuts; `closeSlivers`
  applies last. Same one list for every consumer (render, preview, CapCut export, review, srt,
  agent, editor). The editor's "N pauses · Xs" label now reflects the merged pause+gap total.
- No new setting: gap cuts ride the existing `tightenPauses` toggle/minGap/margin.

## Consequences

- `pmvckyq2lea76f9` through the real source: 23.80 s → 32.31 s removed (program 63.0 → 54.5 s);
  the complaint span is one cut 67.43–80.20. Two gaps elsewhere were vetoed by their own deleted
  words' loud runs minus exemption — net, all qualifying dead air went.
- Residual risk (same as capcut's): a transcription hole containing *quiet* speech (< −35 dBFS
  sustained) is not caught by the guard and would be cut. ADR-005's measurement shows this
  recording's speech p50 is −34.9 dBFS, right at the floor; the 200 ms hold is what separates
  voice from breath here. Ear-check on the next real export is the live verification.
- The −35/200 ms constants are capcut's, adopted deliberately with the ADR-005 caveat in mind
  ("never take dBFS constants from another recording setup") — they were re-measured on THIS
  recording before adoption: kept-word envelope p10 −49.4 / p50 −34.9 / p90 −27.7.
- Speech data adds ~60 ranges to state.json per minute-scale project. Negligible.

## Tests

`tests/gap-cuts.cjs` (8): speech-run detection floor and 200 ms hold, breath at −42 dBFS ignored,
gap cut minus margins, transcription-hole veto, deleted-word exemption, minGap/disabled/missing
guards, leading+trailing gaps, deriveCuts merge. Mutation-tested: `GAP_SPEECH_TOLERANCE` 0.05→999,
deleted-span exemption removed, hold threshold removed — each killed; `edl.ts` and
`audio-envelope.ts` sha256-verified after restore. Suite: 110 pass under Node 24.

## Related

- ADR-005 — the quiet-region path this layers onto (its "audio alone" stance stands for pause
  cuts; gap cuts reintroduce the transcript as a *candidate generator* only, with the audio still
  holding veto power — the inverse of the word-veto design ADR-005 measured and rejected).
- capcut ADR-033 — the speech guard this ports; ADR-030 — the decoded-audio groundwork there.

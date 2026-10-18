# ADR-005: "Tighten pauses" cuts quiet audio, decided by the audio alone

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

Deleting words removes speech but leaves the dead air between sentences. On the test recording
(`pmv8bmero5904aa`, 667.0 s) the no-speech stretches of 2 s or more total 214.7 s. Three detection
rules were measured on the real WAV before this one (details in `docs/learnings.md`):

- A -40 dBFS floor found 38 pauses, 31 of them containing transcribed words. Speech here sits at
  p10 -66.8 / p50 -35.0 / p90 -25.9 dBFS, so -40 cuts quiet speech.
- "No transcribed word inside the pause" at -50 dBFS left 12-65 s silences in. Whisper stretches
  words across silence and puts words on near-silence.
- A 60 ms click tolerance let a -44 dBFS "If you" into a cut.

## Decision

- `findQuietRegions` (`src/lib/audio-envelope.ts`) marks every 10 ms hop at or below -50 dBFS as
  quiet. A loud run shorter than 20 ms (a click) does not end a region. Regions shorter than 0.3 s
  are not stored. Transcript words do not veto a region.
- Regions are stored on the project as `pauses` with `pausesVersion` (`PAUSE_ANALYSIS_VERSION`,
  now 3). They are written at transcribe and backfilled on `GET /api/projects/:id` when the
  version differs.
- `pauseCuts` (`src/lib/edl.ts`) cuts each pause of at least `minGap`, keeping `margin` on each
  side. `deriveCuts` merges these with the unchanged word cuts (`computeCuts`). Every cut
  consumer uses `deriveCuts`: render, review, srt, agent, the editor, and MCP.
- The setting `tightenPauses {enabled, minGap, margin}` is part of `EditState`, so undo, redo and
  save include it.
  - Default: on, 1.0 s, 0.25 s.
  - `validPauseSettings` requires `0.3 <= minGap <= 60`, `margin >= 0` and `margin*2 < minGap`.
  - The setting is reachable through the editor card, `PUT` op `setPauses`, and the MCP tool
    `remove_silences`.
- Background sound between words is not handled (Carlos: rare). Measured: 26.1 s of no-speech
  audio stays in the export, all in gaps of 1.9 s or less, with bursts at speech level. Treating
  sounds shorter than 0.2-0.5 s as pause gains 8-10 s but puts -31 to -26 dBFS audio inside cuts.

## Consequences

- Test export: 450.683 s (program 450.795 s), 216.2 s removed; Carlos accepted it by ear.
- A loud click inside a pause is cut with it; any sound of 20 ms or more keeps the audio around it.
- A recording with a noise floor above -50 dBFS gets no pauses. That is a fail-safe: nothing is
  cut. The floor is fixed, not relative to the recording.
- More cuts means more of the known render drift (`src/lib/ffmpeg.ts` loses about 4 ms per kept
  segment). Out of scope here.
- Stored pauses from v1 and v2 are re-analyzed on the next GET. On the test project, v3 gives 133
  pauses (v2: 132) and the same 60 cuts.

## Tests

`tests/silence.cjs` (9 tests): quiet region floor and 20 ms click, a 20 ms sound ends a pause,
min/margin, a whisper word inside a pause does not block it, disabled == word cuts only, merge +
program sum, undo/validation, an exact-minimum region or pause at any position (float tolerance),
a trailing region never past the audio, minGap below 0.3 rejected. Each of the last three fixes was
reverted individually and its test failed; the files were restored and verified by sha256. Suite:
55 pass under Node 24.

## Review

- **Astra round 1, NOT CLEAN:**
  - medium: float drop of exact-minimum regions and pauses;
  - low: a rounded endpoint past the audio;
  - low: PUT accepted `minGap` below 0.3.
  - All fixed with tests; version bumped to 3.
- **Astra round 2, CLEAN.**

## Update 2026-10-14

- **Correction:** the Decision line "Default: on, 1.0 s, 0.25 s" is wrong. `DEFAULT_PAUSES`
  (`src/lib/edl.ts`) is **off**, 1.0 s, 0.25 s. Tighten pauses is turned on per project in the
  editor card or with `setPauses` / `remove_silences`. The code is right; it was found by an
  independent done-check.
- **Guard:** `tests/retakes.cjs` "DEFAULT_PAUSES matches ADR-005" asserts the default.

## Update 2026-10-14 (slivers)

Carlos saw many tiny clips between the real cuts in a CapCut export. On `pmv8oeuf8803135`, 14 of
80 kept clips were under 0.1 s, each holding only silence or deleted words: a pause margin next to
a word cut, or a deleted word too short (`MIN_CUT`) to be cut on its own.

`deriveCuts` now ends with `closeSlivers`: a kept gap under `MAX_SLIVER` (0.3 s) between two cuts,
with no kept word overlapping it by more than 10 ms, joins the two cuts. A short gap holding a kept
word stays ("So", 0.29 s). Same project: 61 clips, none of them slivers. It applies to every
consumer of `deriveCuts` (render, preview, CapCut, review, srt, MCP), with Tighten pauses on or off.

**Tests:** 4 in `tests/silence.cjs`, written by a fresh agent. Mutants `MAX_SLIVER` 0.3→0.05, the
speech check removed, and `<` → `<= 0` were each killed; `edl.ts` sha256 verified after restore.
Suite: 96 pass under Node 24.

**Update 2026-10-14 (tolerance test):** a kept word that overlaps the gap by 0.008 s does not
block the merge, and one that overlaps by 0.02 s does (`tests/silence.cjs`). The mutant `> 0.01` →
`> 0.0` was killed and sha256 was verified. Suite: 102 pass.

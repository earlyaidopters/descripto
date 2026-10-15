# ADR-007: Repeated takes get an AI check on open, plus two local fixes

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

ADR-006 shipped local-only retake detection; the AI pass was deferred. Carlos reviewed the test
project (`pmv8bmero5904aa`) and found repeats it missed. In Auto Cut (capcut) the AI pass ran by
itself when a project opened.

Measured on the test project (128 phrases), with capcut's own prompt through `claude -p`:
- The AI flagged 4 repeats the local detector missed:
  - 1:34 → 1:38, a reworded restart ("the tool I'm using…");
  - 3:22, "on top of that every quarterback that has faced", said twice inside one phrase;
  - 7:44, the abandoned fragment "It's going to be Ken versus.";
  - 8:46 → 8:51, "so because that line shifted away from them", a plain prefix restart.
- The local detector found 8:46 as a prefix, then dropped it: the keeper goes on to say "60
  points", and the figure guard required identical figures.

## Decision

### Local fixes (`src/lib/retakes.ts`)

- **Figure guard:** every figure of the earlier take must reappear in the keeper. The keeper may
  add figures. Different figures ("54.5" / "47.5", "-5" / "5") are still rejected.
- **Stutter pass:** a run of 3 to 12 words said twice back to back inside one phrase is a retake
  of kind `stutter`. The first run is the bad take and the second the keeper. A run made only of
  number words is skipped ("two two two"), and the figure guard applies.
- Local result on the test project goes from 6 to 8 (adds 3:22 and 8:46).

### AI check (`src/lib/retakes-ai.ts`, `POST /api/projects/:id/retakes`)

- The prompt is capcut's `_SYSTEM_PROMPT`, verbatim. It is run through `~/bin/claude-safe
  --safe-mode --tools '' --no-session-persistence -p` on `claude-sonnet-5`, effort medium,
  using the subscription rather than an API key. The transcript is sent over stdin.
- **Validation:** the same as capcut's. The index must be in range, bad must come before good,
  the hook (phrase 0) is never flagged, there is one pair per bad, and a keeper is never also a
  bad take. Pairs below 0.75 confidence are dropped here; capcut only asked the model for that.
- **Storage:** pairs are stored on the project as `aiRetakes`, by word id.
- **Re-checks:** `findRetakes` shows an AI pair only while every word of both takes is still
  kept, and never over a take the local passes already placed.
- **Editor:** the check runs by itself the first time a transcribed project opens (no
  `aiRetakes` yet). An **AI check** button re-runs it. AI rows carry an "AI" tag and the model's
  reason in the tooltip.
- Nothing is cut without a click, and Cut all includes AI rows.
- **claude-safe watchdog:** it is off for this call (`CLAUDE_SAFE_MAX_SECONDS=0`). Its
  background `sleep` inherited stdout and held the pipe open for the whole limit, so a 6 s
  answer took 290 s. The route's own timer (330 s) is the limit.
  - Measured: the CLI exited at 5.6 s and the pipe closed at 288 s.
  - With the watchdog off: 5.3-6.4 s.

## Consequences

- Test project: 10 proposals after the AI check (8 local + 2 AI-only).
- The AI result varies between runs. Two runs both had 1:34, 7:44 and 8:46; one run added
  "putting a lot of eggs in one basket". Stored results are what the editor shows until the
  check is run again.
- If `claude-safe` is missing, logged out, or out of plan quota, the card shows the error and the
  local results are unaffected.
- A PUT that loaded the project before the AI check saved can overwrite `aiRetakes`. This is the
  same last-writer race as `lastReview`. Re-run the check if it happens.

## Tests

`tests/retakes.cjs` gained 22 tests, written by a fresh agent that did not build the feature. They
cover:
- the figure guard (a keeper may add figures);
- the stutter pass: a 3-word run is flagged, a 2-word run is not, number shorthand is not, a
  repeat across phrases is not a stutter, and a sign difference is not;
- the AI merge: an AI pair is shown while every word is kept, dropped once a word is deleted or
  inside a cut, never duplicates a local take, and results stay sorted;
- `parseAiRetakes`: plain and fenced JSON, hook, order, range, confidence floor, duplicate bad,
  bad that is an earlier keeper, non-JSON error, non-array;
- the `aiRetakePrompt` format.

19 mutants of `retakes.ts` and `retakes-ai.ts` each failed their test, and both files were
verified by sha256 after restore. Suite: 92 pass under Node 24.

**Declined:** `runAiRetakeCheck` (it spawns the real CLI), the route, and the editor auto-run.
These were covered by the live runs above.

## Update 2026-10-14 (final done-check)

A coverage sweep by a separate agent found three cheap gaps. Another fresh agent added tests for
them; suite now 102 pass under Node 24:
- **Prompt pin:** `AI_RETAKE_SYSTEM_PROMPT` is pinned by sha256
  (`186bea95…`). The agent extracted capcut's `_SYSTEM_PROMPT` read-only from
  `core/ai_detector.py`, with `AI_LOOK_AHEAD=10`, and confirmed it byte-identical to descripto's.
  `AI_RETAKE_MODEL` is `claude-sonnet-5` and `AI_RETAKE_EFFORT` is `medium`.
- **Stutter cap:** a 12-word run repeated back to back is a stutter, and a 13-word run is not.

The mutants (one prompt word changed, cap 12→13) were each killed, and sha256 was verified after
restore.

**Evaluated and declined:** the editor's AI check button and auto-run wiring, as before. There is
no React test harness; they are covered by live runs.

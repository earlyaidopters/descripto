# ADR-006: Repeated takes are highlighted with a one-click cut, never cut automatically

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

Carlos re-records lines on camera. He asked for capcut's and Auto Cut's behaviour: "do it extremely
well to highlight for me". capcut already has a measured multi-pass detector:
- `my-project/capcut/core/duplicate_detector.py`;
- thresholds in `config.py:160-165`;
- restart phrases in `config.py:317`;
- capcut ADR-001, -008 and -066.

Its records say:
- Local similarity alone was about 60% accurate, with false positives on negations ("I like it" /
  "I don't like it"). An AI pass took it to about 90%.
- The governing rule is "better to miss a bad take than to cut good content" (capcut ADR-008).

## Decision

### Detector

`src/lib/retakes.ts` is a pure function, ported from capcut.
- **Similarity:** `similarity` equals `difflib.SequenceMatcher(...).ratio()` on word lists.
- **Passes:**
  - restart phrases;
  - adjacent ≥ 0.70;
  - windowed N+2..N+3 ≥ 0.65;
  - prefix restart ≥ 0.5;
  - short fragment;
  - chain consolidation;
  - straggler ≥ 0.55.
- **Keeper:** the last take always wins.

### Additions over capcut

- **Phrase building:** Groq gives a zero-gap word transcript, so phrases are built by splitting at
  sentence ends, at stored pauses of 0.8 s or more (each assigned by its midpoint), and every 25
  words.
- **Words never compared:** deleted words, and words inside a current cut. In the test recording
  this includes "Let's get right into that.", which whisper invented on silence that Tighten pauses
  already removes. It was being offered as the keeper.
- **Pairs rejected:** a pair is dropped when only one side is negated, or when the figures differ
  ("54.5 on the under" / "the under 47.5", "-5" / "5"). Figures are read from the original text.
  The check applies again to the final pair after chain consolidation, and a rejected straggler
  candidate does not stop the search.

### Editor

- Earlier takes are tinted red and keepers underlined green. A restart-phrase keeper is not marked,
  as in capcut.
- A "Repeated takes" card lists each earlier take at its edited-timeline time, with a **Cut**
  button. Cut deletes that take's word ids through the existing undoable `setDeleted` path.
- Nothing is cut without a click.

### MCP and AI

- **MCP:** `find_retakes` is read-only. It imports the `.ts` modules through Node 24 type stripping;
  on an older Node it returns an explicit error.
- **AI pass:** none in this phase (Carlos's call). Local detection ships first and is measured; an
  AI re-check is its own later phase.

## Consequences

- Test recording (667 s, 134 phrases): 6 retakes, all plausible.
  - 2:24 straggler;
  - 3:45 false start;
  - 7:42 repeated line;
  - 9:17 "I'm taking Ken." false start;
  - 9:59 repeated line;
  - 10:00 "Kenshaw State" → "Kenshaw Moneyline".
- Before the guards, three false matches appeared: a negation, different numbers, and an invented
  keeper.
- Reworded restarts with low word overlap are missed. That is the AI pass's job.
- Retakes are recomputed on every edit (memoized on words, pauses and cuts). After a Cut the pair
  disappears; Undo brings it back.
- Turning Tighten pauses off brings whisper's invented words back into comparison.

## Tests

`tests/retakes.cjs`, 11 tests:
- difflib parity;
- adjacent, chain and prefix detection;
- the negation and figure guards;
- restart phrases;
- cut and deleted words excluded;
- pause splitting;
- consolidated pairs re-checked;
- a straggler search that continues past a rejected keeper;
- signed and decimal figures.

12 mutants of `retakes.ts` were each killed, and the file was verified by sha256 after restore.
Suite: 66 pass under Node 24.

Live checks:
- MCP probe through a real stdio client on a copy of the state: same results.
- Playwright on the dev server: Cut takes deleted words from 15 to 32 and the count from 5 to 4;
  Undo returned both.

## Review

- **Astra round 1, NOT CLEAN.** Three medium findings:
  - consolidation bypassed the guards;
  - a rejected straggler hid a later keeper;
  - token cleanup erased signs and decimals.
  All fixed with tests.
- **Astra round 2, CLEAN.**

## Update 2026-10-14

An independent done-check listed untested contracts. A separate agent added 4 tests to
`tests/retakes.cjs`:
- a windowed match 3 phrases later is flagged, and 4 phrases later is not;
- a run with no punctuation is split every 25 words;
- a restart-phrase pair is `keyword` with similarity 1, even when the phrases share no words;
- `DEFAULT_PAUSES` is off.

For the first two, mutants (`WINDOW = 4`, `SEGMENT_MAX_WORDS = 26`) were confirmed to fail, and
the source was restored and verified by sha256. Suite: 70 pass.

**Evaluated and declined** (no cheap test in the existing convention):
- the editor card, tints and Cut/Undo (covered by Playwright checks this session, not
  automated);
- the MCP `find_retakes` tool and its Node type-stripping error path;
- the API routes, plus `store.ts` / `transcribe.ts` persistence and backfill;
- boundary tests for each threshold.

## Update 2026-10-14 (Cut all)

Carlos asked for a **Cut all** button. It sits in the card header and shows when there are 2 or
more retakes. It deletes every earlier take's words in one `setDeleted` call: one snapshot, so a
single Undo restores them all. Keepers are never in a `bad` set after consolidation, so no kept
take is cut. Live check on the test project: 6 retakes / 44 red words → 0 / 0, Undo → 6 / 44.

**Evaluated and declined (2026-10-14):** an automated test of Cut all's wiring (one `setDeleted`
call, shown only with 2 or more retakes). It is an inline React handler, and the repo has no
component test harness. The undo-snapshot behaviour it relies on is covered by
`tests/edit-state.cjs`, and the button was checked live (6 / 44 → 0 / 0, Undo → 6 / 44).

# ADR-011: No margin at the program's lead-in/tail-out edges

**Status:** Accepted
**Date:** 2026-10-18
**Authors:** Carlos, Claude
**Project:** descripto
**Amends:** ADR-010 (the `margin each side` clause, including the lead-in/tail boundary cuts)

## Context

Carlos saw tiny clips at the very start/end of a cut export — a symptom already seen once before
(`docs/learnings.md`, 2026-10-14 slivers fix) and at the time logged as an *accepted* residual:
"none under 0.25 s apart from the 0.25 s lead-in at 0:00." ADR-010 then wrote the same boundary
margin into the decision explicitly: gap cuts at the lead-in (`g.start === 0`) and, when
`sourceDuration` is known, the tail (`g.end === sourceDuration`) kept `margin` on both sides like
any interior gap.

`margin` exists to protect a sliver of silence next to **kept speech** on the far side of a cut.
At the program's outer edges there is no kept speech beyond the boundary — nothing to protect —
so subtracting `margin` there only strands an uncut sliver of silence at position 0 or at
`sourceDuration`. That sliver is what Carlos saw.

## Decision

- `gapCuts` (`src/lib/edl.ts`) no longer subtracts `margin` on the edge of a gap that touches a
  program boundary: `start = g.start + (g.start === 0 ? 0 : margin)`,
  `end = g.end - (g.end === sourceDuration ? 0 : margin)`. The speech-facing margin on the
  *inner* side of a boundary gap is unchanged — only the outer, boundary-touching side drops it.
  No new setting; this rides the existing `tightenPauses margin`.

## Consequences

- Lead-in/tail-out gaps now cut flush to 0 / `sourceDuration` instead of leaving a margin-sized
  sliver there. Interior gaps and the speech-facing side of boundary gaps are unaffected.
- Relies on strict equality (`g.start === 0`, `g.end === sourceDuration`) to identify a boundary
  gap. Safe as implemented: boundary gaps are assigned `0`/`sourceDuration` directly at
  construction, not derived by arithmetic. If gap construction ever changes to compute these by
  arithmetic, this needs an epsilon/clamp (flagged by Codex review, not yet needed).
- Supersedes the "0.25 s lead-in at 0:00" residual accepted in the 2026-10-14 learnings.md entry
  — that sliver is now closed by removing its cause instead of tolerating it.

## Tests

`tests/gap-cuts.cjs`: updated the leading/trailing-silence case to assert `start === 0` (was
`0.25`) and `end === sourceDuration` (was `sourceDuration - 0.25`) when a boundary gap qualifies.
8/8 pass.

## Related

- ADR-010 — this amends only the boundary-margin clause; the speech guard, transcription-hole
  veto, and deleted-word exemption are unchanged.
- `docs/learnings.md` 2026-10-14 — the slivers fix that first surfaced and accepted this residual.

# ADR-004: "like" is never auto-flagged as a filler

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

"Remove fillers" deletes every word `markFillers` flags. `FILLERS` (`src/lib/edl.ts`) included
"like" as a single-word match, so the export of the latest project (`pmv8bmero5904aa`) cut real
phrases: "which ones I'd like to look at", "stuff like that", "if you like this sort of
information". capcut keeps "like" in an opt-in aggressive tier for the same reason (capcut
ADR-011, `config.py:284`). On this transcript the 25 flagged fillers were like x10, actually x7,
basically x6, sort of x1; Groq produced no "um"/"uh" at all.

## Decision

"like" is removed from `FILLERS` and is never flagged automatically (commit `be7c157`). Every
other entry of `FILLERS` and `PHRASE_FILLERS` is unchanged, including "actually", "basically" and
"sort of". Carlos can still delete any "like" by hand.

## Consequences

- Filler "like" ("like I said", "as far as like receptions") is no longer removed by the button;
  on the latest project fillers go 25 -> 15.
- Existing projects keep their stored `filler` flags until re-marked (transcribe, audit, agent).
- "sort of" after a determiner ("this sort of information") is still flagged; not addressed here.

## Tests

`tests/fillers.cjs` (2 tests). Mutation-audited by a separate agent, each restore sha256-verified:
re-adding "like" to `FILLERS` and adding a `["like","i"]` phrase both fail test 1; dropping
"actually" and breaking the `["sort","of"]` phrase both fail test 2. Full suite 52/52 under Node 24.

## Alternatives Considered

- Context rules (keep "like" a filler except after a subject/modal/perception verb or before an
  object; keep "sort of"/"kind of" after a determiner): built and dry-run on the real project
  (25 -> 20, exactly the four wrong cuts dropped), then dropped on Carlos's call: "like" cuts too
  many real phrases to trust a word list.
- Hesitation-only default list (capcut's default): would flag nothing on Groq transcripts, which
  contain no "um"/"uh".

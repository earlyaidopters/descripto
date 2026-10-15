# ADR-009: Projects can be deleted from the projects screen, one or many, after a confirm

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

Carlos asked (P2) for a way to clear the projects screen. Test runs had left 8 projects there,
using about 3 GB. Each project folder holds descripto's own copy of the recording (`source.mkv` or
`source.mp4`), the transcript, the edits and the renders. A `DELETE /api/projects/:id` route
already existed, but nothing in the UI called it.

## Decision

- **One project:** each card has a **×** button in its top-left corner. It shows on hover, and is
  always visible on touch screens.
- **Many projects:** a button next to New project deletes every card currently shown. It reads
  **Clear list** with no search or filter active, and **Clear N shown** when one is, so a filtered
  view never deletes hidden projects.
- **Confirm:** both ask with `window.confirm`, which names the project or the count. The text says
  what is removed and that this cannot be undone.
- **Deleting:** the client calls the existing route once per project, then reloads the list. Any
  failures are named in the error banner.
- **What is removed:** the whole project folder, including descripto's copy of the media. The
  original recording, CapCut projects and the CapCut copies in `Desktop\CONTENT\video` are never
  touched, because they live outside the project folder.

## Consequences

- No undo. The confirm is the only guard.
- Hidden by a filter means safe: Clear N shown affects only the visible cards.
- **Evaluated and declined: automated tests.** The repo has no React or component test harness.
  The route was unchanged. Checked live with Playwright on the dev server: the per-card confirm
  names the project, Clear list asks "Delete 8 projects?", and a search changes the label to
  "Clear 1 shown". Every confirm was dismissed and all 8 projects were still there afterwards.

## Alternatives Considered

- **Hide from the list without deleting:** rejected. The disk use is the real problem, about
  320-720 MB per project.
- **A custom confirm dialog:** deferred. The native confirm is enough for a local, single-user app.

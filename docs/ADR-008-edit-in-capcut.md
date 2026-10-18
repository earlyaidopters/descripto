# ADR-008: "Edit in CapCut" writes a new CapCut project with capcut's own generator

**Status:** Accepted
**Date:** 2026-10-14
**Authors:** Carlos
**Project:** descripto

## Context

Carlos asked (P1) for a button that sends the current edit to CapCut so he can keep editing there.
His capcut tool (`my-project/capcut`) already exports to CapCut by writing a draft folder into
CapCut's Projects directory. Carlos confirmed that path live in CapCut 9.2 (capcut ADR-062/064/065).
XML import is used there only for DaVinci Resolve.

## Decision

- **Button:** "Edit in CapCut", in the editor top bar, calls `POST /api/projects/:id/capcut`.
- **Route:**
  - Refuses with 409 while `CapCut.exe` is running. CapCut scans its Projects folder only at
    start, and rewrites its list on exit.
  - Sends `{source, name, cuts}` to `scripts/capcut_export.py` over stdin. The cuts are
    `deriveCuts`, in source seconds.
  - Then starts CapCut with `powershell.exe Start-Process`.
- **`scripts/capcut_export.py`:** runs under WSL python3 and imports the capcut repo; nothing in
  capcut is changed.
  1. Remuxes the source (`.mkv` in WSL) to `Desktop/CONTENT/video/<name> (descripto).mp4` with
     stream copy, so CapCut on Windows can read it.
  2. `generate_project()` with the full clip and no transcript (`segments=[]`).
  3. `split_video_for_bad_takes()`, with `build_cut_ranges` swapped for descripto's cut list.
     The draft starts as one clip at source time, so source-time cuts are timeline-time cuts.
  4. `validate_project()`, then `save_project()` to the draft and its `Timelines/` copies.
- **Names are never reused.** `generate_project()` writes into an existing folder of the same
  name, which would overwrite a project already edited in CapCut. The script counts up instead:
  `(descripto)`, `(descripto 2)`, and so on. The same name is used for the `.mp4`, and ffmpeg
  runs with `-n` (no overwrite).

## Consequences

- **Test project:** 60 cuts give 61 clips with no gaps. The timeline is 450.749 s against
  descripto's program of 450.795 s (46 ms, the mp4 remux duration). The media path is
  `C:/Users/...`. The live button click created the project and opened CapCut.
- **Coupling:** this depends on the capcut repo at `~/my-project/capcut` (`CAPCUT_REPO`
  overrides it), its templates (CapCut 8.1.1 shape) and its Python deps. A capcut refactor of
  those functions breaks this button.
- **Machine:** Main-PC only. The paths are `carlo.MAIN-PC` defaults; `CAPCUT_EXE` and
  `DESCRIPTO_CAPCUT_VIDEO_DIR` override them.
- **Disk:** each export copies the full source into CONTENT/video.
- **No transcript in CapCut.** Captions are not carried over.
- **Earlier test:** before the counter existed, a direct script test and the first button test
  wrote the same folder. That project has a stale second `Timelines/` entry. Delete it in CapCut
  if it looks wrong.

## Tests

- **Numbering:** two runs into temp folders (`CAPCUT_PROJECTS_DIR`, `DESCRIPTO_CAPCUT_VIDEO_DIR`)
  produced `(descripto)` and `(descripto 2)`, each with 61 clips.
- **Declined:** no automated test, because it needs CapCut's templates, ffmpeg and a real video.
  It was covered by the live run.

**Evaluated and declined (2026-10-14):** a test of the Edit in CapCut button's enable rules
(transcribed, video size known, program longer than 0, edits saved). It is UI only, with no React
test harness. Live: the button stays disabled until "All changes saved".

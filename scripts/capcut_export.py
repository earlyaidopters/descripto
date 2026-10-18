"""Export a descripto edit as a new CapCut project (ADR-008).

Reads JSON on stdin: {"source": <video path>, "name": <project name>, "cuts": [[start_s, end_s], ...]}
(cuts in SOURCE seconds, already merged). Writes one JSON line to stdout:
{"project": <dir>, "video": <mp4 path>} or {"error": <message>}.

Reuses capcut's own generator and splitter (my-project/capcut, ADR-062/064/065 there), the path
Carlos confirmed live in CapCut 9.2, instead of re-creating CapCut's draft format here:
  1. remux the source into the CONTENT/video folder as .mp4 (stream copy, no re-encode), so CapCut
     on Windows can read it;
  2. generate_project(): a fresh draft with the full clip;
  3. split_video_for_bad_takes() with its cut list replaced by descripto's cuts (the draft starts
     as one clip at source time, so source-time cuts are timeline-time cuts);
  4. validate_project() + save_project() to the draft and its Timelines/ copies.
CapCut must be closed: it scans its Projects folder only at start, and rewrites its list on exit.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

CAPCUT_REPO = Path(os.environ.get("CAPCUT_REPO", Path.home() / "my-project" / "capcut"))
VIDEO_DIR = Path(os.environ.get("DESCRIPTO_CAPCUT_VIDEO_DIR", "/mnt/c/Users/carlo.MAIN-PC/Desktop/CONTENT/video"))


def safe_name(name: str) -> str:
    return "".join(c for c in name if c not in '<>:"/\\|?*').strip() or "descripto"


def main() -> dict:
    req = json.load(sys.stdin)
    source, name = req["source"], safe_name(req["name"])
    cuts_us = [(int(round(s * 1e6)), int(round(e * 1e6))) for s, e in req["cuts"] if e > s]

    sys.path.insert(0, str(CAPCUT_REPO))
    os.chdir(CAPCUT_REPO)  # capcut's config resolves its .env and templates relative to the repo
    import config
    import core.project_writer as pw
    from core.project_generator import generate_project
    from core.video_metadata import get_video_metadata

    if not config.CAPCUT_PROJECTS_DIR or not Path(config.CAPCUT_PROJECTS_DIR).is_dir():
        return {"error": "CapCut projects folder not found"}

    # Never reuse a name: generate_project() writes INTO an existing folder of the same name, which
    # would overwrite a project Carlos already edited in CapCut. Same counter for the video file.
    projects = Path(config.CAPCUT_PROJECTS_DIR)
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        label = f"{name} (descripto{'' if n == 1 else f' {n}'})"
        if not (projects / label).exists() and not (VIDEO_DIR / f"{label}.mp4").exists():
            break
        n += 1
    video = VIDEO_DIR / f"{label}.mp4"
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
                        "-movflags", "+faststart", "-n", str(video)], capture_output=True, text=True)
    if r.returncode != 0:
        return {"error": f"remux to mp4 failed: {r.stderr.strip()[:300]}"}

    project = generate_project(video_path=str(video), project_name=label,
                               video_metadata=get_video_metadata(str(video)), segments=[],
                               capcut_projects_dir=config.CAPCUT_PROJECTS_DIR,
                               media_folders=config.CAPCUT_MEDIA_FOLDERS)
    draft = Path(project) / "draft_content.json"
    data = json.loads(draft.read_text(encoding="utf-8"))
    pw.build_cut_ranges = lambda _pairs, _segments: cuts_us  # descripto's cuts, not transcript pairs
    data = pw.split_video_for_bad_takes(data, [], [])
    warnings = pw.validate_project(data)
    pw.save_project(data, str(draft))
    for tl in (Path(project) / "Timelines").glob("*/"):
        if (tl / "draft_content.json").exists():
            pw.save_project(data, str(tl / "draft_content.json"))
    return {"project": project, "video": str(video), "clips": sum(len(t.get("segments", [])) for t in data.get("tracks", []) if t.get("type") == "video"), "warnings": warnings[:10]}


if __name__ == "__main__":
    try:
        out = main()
    except Exception as e:  # noqa: BLE001 - reported to the editor as one line
        out = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out))

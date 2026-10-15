import fs from "fs";
import path from "path";
import crypto from "crypto";
import { deriveCuts, programDuration } from "./edl";
import type { ProjectState } from "./types";

// ── File-based project store ────────────────────────────────────────────────
// projects/<id>/state.json is the single source of truth. All mutations go
// through load → modify → save. Local single-user app; no locking needed.

const ROOT = path.join(process.cwd(), "projects");

export function projectsRoot(): string {
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

export function projectDir(id: string): string {
  if (!/^p[a-z0-9]+$/.test(id)) throw new Error("Invalid project ID");
  return path.join(projectsRoot(), id);
}

export function statePath(id: string): string {
  return path.join(projectDir(id), "state.json");
}

export function newId(): string {
  return `p${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

export function wordId(i: number): string {
  return `w${i}`;
}

export function loadProject(id: string): ProjectState | null {
  const p = statePath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ProjectState;
}

export function saveProject(state: ProjectState): void {
  fs.mkdirSync(projectDir(state.id), { recursive: true });
  const tmp = statePath(state.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(state.id));
}

export function listProjects(): { id: string; name: string; createdAt: string; duration: number; transcribed: boolean }[] {
  const root = projectsRoot();
  const out: { id: string; name: string; createdAt: string; duration: number; transcribed: boolean }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const st = loadProject(entry.name);
      if (st) {
        out.push({ id: st.id, name: st.name, createdAt: st.createdAt, duration: programDuration(deriveCuts(st), st.sourceDuration), transcribed: st.transcribed });
      }
    } catch {
      // corrupt dir — skip
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function rendersDir(id: string): string {
  const d = path.join(projectDir(id), "renders");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

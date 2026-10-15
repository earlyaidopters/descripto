import type { PauseSettings, ProjectState } from "./types";
export type EditState = { words: { id: string; text: string; deleted: boolean }[]; studioSound: boolean; tightenPauses?: PauseSettings };
export function captureEdits(project: ProjectState): EditState {
  return { words: project.words.map(({ id, text, deleted }) => ({ id, text, deleted })), studioSound: project.studioSound, ...(project.tightenPauses ? { tightenPauses: { ...project.tightenPauses } } : {}) };
}
// Finite, non-negative, minimum pause at most a minute, and the kept margins leave something to cut.
export function validPauseSettings(value: unknown): value is PauseSettings {
  const v = value as PauseSettings;
  return !!v && typeof v.enabled === "boolean" && Number.isFinite(v.minGap) && Number.isFinite(v.margin) && v.minGap >= 0.3 && v.minGap <= 60 && v.margin >= 0 && v.margin * 2 < v.minGap;
}
export function applyEdits(project: ProjectState, value: unknown): void {
  const edit = value as EditState;
  if (!edit || !Array.isArray(edit.words) || typeof edit.studioSound !== "boolean" || edit.words.length !== project.words.length) throw new Error("Invalid edit state. Reload the project and try again.");
  const byId = new Map(edit.words.map(w => [w?.id, w]));
  if (edit.tightenPauses !== undefined && !validPauseSettings(edit.tightenPauses)) throw new Error("Invalid pause settings. Keep each side shorter than half the minimum pause.");
  if (byId.size !== project.words.length || project.words.some(w => { const e = byId.get(w.id); return !e || typeof e.deleted !== "boolean" || typeof e.text !== "string" || !e.text.trim() || e.text.length > 2000; })) throw new Error("The transcript changed. Reload before saving these edits.");
  for (const word of project.words) { const edit = byId.get(word.id)!; word.text = edit.text; word.deleted = edit.deleted; }
  project.studioSound = edit.studioSound;
  if (edit.tightenPauses) project.tightenPauses = { ...edit.tightenPauses };
  else delete project.tightenPauses;
  for (const correction of project.lastAudit?.corrections || []) correction.applied = byId.get(correction.wordId)?.text === correction.suggested;
}

// Serialize writes and coalesce queued snapshots. Failed saves retain the latest
// local edit; a retry can never overwrite it with an older request.
export function createEditQueue<T>(write: (value: T) => Promise<void>, changed: (status: "saved" | "saving" | "error", error?: string) => void) {
  let pending: { value: T } | undefined;
  let running = false;
  let failed = false;
  async function flush() {
    if (running || !pending) return;
    running = true; failed = false; changed("saving");
    while (pending) {
      const next = pending; pending = undefined;
      try { await write(next.value); }
      catch (error) {
        pending ||= next; running = false; failed = true;
        changed("error", error instanceof Error ? error.message : "Could not save edits."); return;
      }
    }
    running = false; changed("saved");
  }
  return {
    push(value: T) { pending = { value }; void flush(); },
    retry() { void flush(); },
    isPending() { return running || !!pending || failed; },
  };
}

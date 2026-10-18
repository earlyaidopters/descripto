"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPlaybackClock, EditedTimeline, VideoControls } from "@/components/edited-playback";
import { Icon, StudioMark } from "@/components/studio-icon";
import { DEFAULT_PAUSES, deriveCuts, gapCuts, pauseCuts, programDuration, sourceToProgram, programToSource, type Range } from "@/lib/edl";
import type { PauseSettings } from "@/lib/types";
import { nextPreviewTime } from "@/lib/preview";
import { findRetakes } from "@/lib/retakes";
import { fmtTime, type AuditReport, type ProjectState, type ReviewReport } from "@/lib/types";

import { captureEdits, applyEdits, createEditQueue, validPauseSettings, type EditState } from "@/lib/edit-state";

type Tab = "review" | "audit" | "agent";

export default function EditorClient({ id, initialProject }: { id: string; initialProject: ProjectState }) {
  const [project, setProject] = useState<ProjectState>(initialProject);
  const clock = useMemo(createPlaybackClock, []);
  const timelineClock = useMemo(createPlaybackClock, []);
  const pendingRender = useRef<{ time: number; playing: boolean } | null>(null);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState(false);
  const [focusedWord, setFocusedWord] = useState("");
  const actionRunning = useRef(false);
  const startingExport = useRef(false);
  const [serverStatus, setServerStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [renderProg, setRenderProg] = useState<{ pct: number; stage: string } | null>(null);
  const [renderJobId, setRenderJobId] = useState<string | null>(null);
  const [cancellingRender, setCancellingRender] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const cancelPending = useRef(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("agent");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState("");
  const saveQueue = useMemo(() => createEditQueue<EditState>(async edit => {
    const response = await fetch(`/api/projects/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "setEditState", edit }) });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Could not save edits."); }
  }, (status, error) => { setSaveStatus(status); setSaveError(error || ""); }), [id]);
  const [search, setSearch] = useState("");
  const [hideCuts, setHideCuts] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [aiCheck, setAiCheck] = useState<{ busy: boolean; note: string }>({ busy: false, note: "" });
  const [capcutBusy, setCapcutBusy] = useState(false);
  const [review, setReview] = useState<ReviewReport | null>(initialProject.lastReview || null);
  const [audit, setAudit] = useState<AuditReport | null>(initialProject.lastAudit || null);
  const [agentCmd, setAgentCmd] = useState("");
  const [agentLog, setAgentLog] = useState<string[]>([]);
  const [playMode, setPlayMode] = useState<"source" | "render">("source");
  const activeWord = useRef<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const dragging = useRef(false);
  const selectionAnchor = useRef<number | null>(null);
  const rangeGesture = useRef(false);
  const previousCuts = useRef<Range[] | null>(null);
  const pendingPreview = useRef<{ time: number; playing: boolean } | null>(null);
  const history = useRef<EditState[]>([]);
  const future = useRef<EditState[]>([]);

  // ── data ─────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${id}`);
      if (!r.ok) throw new Error("Project not found");
      const j = await r.json();
      setProject(j.project);
      setReview(j.project.lastReview || null);
      setAudit(j.project.lastAudit || null);
    } catch (e) {
      setError((e as Error).message || "Could not load this project. Please try again.");
    }
  }, [id]);

  useEffect(() => {
    return (window as any).descripto?.onServerStatus?.((status: string) => {
      setServerStatus(status);
    });
  }, []);

  const words = useMemo(() => project?.words ?? [], [project.words]);
  const wordIndex = useMemo(() => new Map(words.map((word, index) => [word.id, index])), [words]);
  const tabStopWord = words.find(w => w.id === focusedWord && (!hideCuts || !w.deleted))?.id || words.find(w => !hideCuts || !w.deleted)?.id;
  const searchTerm = search.trim().toLocaleLowerCase();
  const matches = words.filter(w => (!hideCuts || !w.deleted) && searchTerm && w.text.toLocaleLowerCase().includes(searchTerm));
  const cuts: Range[] = useMemo(() => deriveCuts({ words, pauses: project.pauses, speech: project.speech, tightenPauses: project.tightenPauses, sourceDuration: project.sourceDuration }), [words, project.pauses, project.speech, project.tightenPauses, project.sourceDuration]);
  const pauseSettings = project.tightenPauses ?? DEFAULT_PAUSES;
  const tightened = useMemo(() => {
    const on = { ...pauseSettings, enabled: true };
    const merged = [...pauseCuts(words, project.pauses, on), ...gapCuts(words, project.speech, on, project.sourceDuration)].sort((a, b) => a.start - b.start);
    const out: Range[] = [];
    for (const c of merged) {
      const last = out[out.length - 1];
      if (last && c.start <= last.end + 0.001) last.end = Math.max(last.end, c.end);
      else out.push({ ...c });
    }
    return out;
  }, [words, project.pauses, project.speech, pauseSettings, project.sourceDuration]);
  const tightenedSec = tightened.reduce((sum, c) => sum + c.end - c.start, 0);
  const progDur = useMemo(
    () => (project ? programDuration(cuts, project.sourceDuration) : 0),
    [cuts, project],
  );
  const deletedCount = words.filter((w) => w.deleted).length;
  const fillerCount = words.filter((w) => w.filler && !w.deleted).length;
  const retakes = useMemo(() => findRetakes(words, project.pauses, cuts, project.aiRetakes), [words, project.pauses, cuts, project.aiRetakes]);
  const retakeIds = useMemo(() => ({ bad: new Set(retakes.flatMap((r) => r.bad.wordIds)), good: new Set(retakes.filter((r) => r.kind !== "keyword").flatMap((r) => r.good.wordIds)) }), [retakes]);
  // Like Auto Cut, the AI check runs on its own the first time a transcribed project opens; the
  // button re-runs it. Proposals only, and the editor stays usable while it runs.
  const aiAutoStarted = useRef(false);
  useEffect(() => {
    if (aiAutoStarted.current || !project.transcribed || project.aiRetakes) return;
    aiAutoStarted.current = true;
    void runAiCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.transcribed, project.aiRetakes]);

  // ── mutations ────────────────────────────────────────────────────────────
  const snapshot = useCallback(() => {
    if (!project) return;
    history.current.push(captureEdits(project));
    if (history.current.length > 100) history.current.shift();
    future.current = [];
  }, [project]);

  const locked = !!busy || !!renderProg;
  const actionDisabled = locked || saveStatus !== "saved";
  function persist() { saveQueue.push(captureEdits(project)); }
  function guardNavigation(e: React.MouseEvent) {
    if (saveQueue.isPending()) { e.preventDefault(); setError("Your edits are not saved yet. Wait for saving to finish, or use Retry save."); }
  }
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (saveQueue.isPending()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [saveQueue]);

  const refreshFromLocal = useCallback(() => {
    setProject((p) => (p ? { ...p, words: [...p.words] } : p));
  }, []);

  function setDeleted(ids: string[], deleted: boolean) {
    if (locked || !ids.some(id => { const word = words[wordIndex.get(id) ?? -1]; return word && word.deleted !== deleted; })) return;
    snapshot();
    const set = new Set(ids);
    for (const w of project.words) {
      if (set.has(w.id) && w.deleted !== deleted) w.deleted = deleted;
    }
    refreshFromLocal();
    persist();
    setSelection(new Set());
  }

  // AI check for repeated takes (ADR-007): headless Claude Code, proposals only.
  async function runAiCheck() {
    setAiCheck({ busy: true, note: "AI check running…" });
    try {
      const res = await fetch(`/api/projects/${id}/retakes`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `AI check failed (${res.status})`);
      setProject((p) => (p ? { ...p, aiRetakes: body.aiRetakes } : p));
      setAiCheck({ busy: false, note: `AI check: ${body.aiRetakes.pairs.length} proposed` });
    } catch (e) {
      setAiCheck({ busy: false, note: (e as Error).message });
    }
  }

  // Export to CapCut (ADR-008): a new CapCut project with the current cuts, then CapCut opens.
  async function exportCapcut() {
    setCapcutBusy(true);
    try {
      const res = await fetch(`/api/projects/${id}/capcut`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `CapCut export failed (${res.status})`);
      setExportNotice(`CapCut project "${body.name}" created (${body.clips} clips).${body.launched ? " Opening CapCut…" : " Open CapCut to edit it."}`);
    } catch (e) {
      setExportNotice((e as Error).message);
    } finally {
      setCapcutBusy(false);
    }
  }

  async function fillers(deleteThem: boolean) {
    if (locked) return;
    snapshot();
    for (const w of project.words) {
      if (w.filler) w.deleted = deleteThem;
    }
    refreshFromLocal();
    persist();
  }

  function setPauses(next: PauseSettings) {
    if (locked) return;
    if (!validPauseSettings(next)) { setError("Keep each side shorter than half the minimum pause."); return; }
    snapshot();
    project.tightenPauses = next;
    setProject((p) => (p ? { ...p, tightenPauses: next } : p));
    persist();
  }

  function restoreHistory(from: React.RefObject<EditState[]>, to: React.RefObject<EditState[]>) {
    if (locked || !from.current.length) return;
    to.current.push(captureEdits(project));
    applyEdits(project, from.current.pop()!);
    setAudit(project.lastAudit ? { ...project.lastAudit } : null);
    setSelection(new Set()); refreshFromLocal(); persist();
  }
  function undo() { restoreHistory(history, future); }
  function redo() { restoreHistory(future, history); }

  function wordKeyDown(e: React.KeyboardEvent, idx: number) {
    const word = words[idx];
    if (e.key === "Enter") { e.preventDefault(); seekSource(word.start); }
    if (e.key === " ") { e.preventDefault(); if (!locked) { selectionAnchor.current = idx; setSelection(new Set([word.id])); } }
    const direction = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    let next = idx + direction;
    while (words[next] && hideCuts && words[next].deleted) next += direction;
    if (!words[next]) return;
    if (e.shiftKey && !locked) {
      selectionAnchor.current ??= idx;
      const anchor = selectionAnchor.current;
      setSelection(new Set(words.slice(Math.min(anchor, next), Math.max(anchor, next) + 1).filter(w => !hideCuts || !w.deleted).map(w => w.id)));
    } else selectionAnchor.current = next;
    document.getElementById(`word-${words[next].id}`)?.focus();
  }

  function findMatch(direction: number) {
    if (!matches.length) return;
    const index = matchIndex < 0 ? (direction > 0 ? 0 : matches.length - 1) : (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(index);
    document.getElementById(`word-${matches[index].id}`)?.scrollIntoView({ block: "center" });
  }

  // Every edit returns an old rendered preview to the current live edit.
  useEffect(() => {
    const previous = previousCuts.current;
    previousCuts.current = cuts;
    if (!previous || JSON.stringify(previous) === JSON.stringify(cuts) || playMode !== "render") return;
    const video = videoRef.current;
    pendingPreview.current = { time: programToSource(previous, video?.currentTime || 0), playing: !!video && !video.paused };
    setPlayMode("source");
  }, [cuts, playMode]);

  // Reconcile immediately on an edit (even paused), at seek/play boundaries,
  // and on animation frames so short deleted words cannot slip between the
  // browser's infrequent timeupdate events.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !project) return;
    let frame = 0;
    let lastWord: string | null = null;
    let lastPublished = -1;
    const sync = () => {
      if (video.readyState === 0) return;
      if (playMode === "render") {
        if (pendingRender.current) { const pending = pendingRender.current; pendingRender.current = null; video.currentTime = pending.time; if (pending.playing) void video.play().catch(() => {}); }
        clock.update(video.currentTime, !video.paused);
        const source = programToSource(project.lastRender?.cuts || cuts, video.currentTime);
        timelineClock.update(Math.min(progDur, sourceToProgram(cuts, source)), !video.paused);
        return;
      }
      if (pendingPreview.current) {
        const pending = pendingPreview.current;
        pendingPreview.current = null;
        video.currentTime = nextPreviewTime(pending.time, cuts, project.sourceDuration);
        if (pending.playing && progDur > 0) void video.play().catch(() => {});
      }
      const time = nextPreviewTime(video.currentTime, cuts, project.sourceDuration);
      if (Math.abs(time - video.currentTime) > 0.0001) video.currentTime = time;
      if (time >= project.sourceDuration || progDur === 0) video.pause();
      if (video.paused || Math.abs(time - lastPublished) >= 0.08) { clock.update(Math.min(progDur, sourceToProgram(cuts, time)), !video.paused); lastPublished = time; }
      timelineClock.update(clock.getSnapshot().time, !video.paused);
      const word = words.find(w => !w.deleted && time >= w.start && time < w.end);
      const found = word?.id || null;
      if (found !== activeWord.current) {
        if (activeWord.current) document.getElementById(`word-${activeWord.current}`)?.classList.remove("active");
        if (found) document.getElementById(`word-${found}`)?.classList.add("active");
        activeWord.current = found;
      }
      if (found && found !== lastWord && !video.paused) document.getElementById(`word-${found}`)?.scrollIntoView({ block: "nearest" });
      lastWord = found;
    };
    const tick = () => { sync(); if (!video.paused) frame = requestAnimationFrame(tick); };
    const start = () => { cancelAnimationFrame(frame); tick(); };
    const pause = () => { cancelAnimationFrame(frame); sync(); };
    video.addEventListener("timeupdate", sync);
    video.addEventListener("seeking", sync);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("play", start);
    video.addEventListener("pause", pause);
    sync();
    if (!video.paused) start();
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("seeking", sync);
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("play", start);
      video.removeEventListener("pause", pause);
    };
  }, [cuts, words, playMode, project.sourceDuration, progDur, clock, timelineClock, project.lastRender]);

  function switchPreview(mode: "source" | "render", renderedTime?: number) {
    const video = videoRef.current;
    if (!video) return;
    if (mode === "render" && project.lastRender) {
      const time = renderedTime ?? (playMode === "source" ? sourceToProgram(project.lastRender.cuts || cuts, video.currentTime) : video.currentTime);
      if (playMode === "render") { video.currentTime = time; return; }
      pendingRender.current = { time: Math.min(project.lastRender.duration, time), playing: !video.paused };
    } else if (mode === "source" && playMode === "render") {
      pendingPreview.current = { time: programToSource(project.lastRender?.cuts || cuts, video.currentTime), playing: !video.paused };
    }
    setPlayMode(mode);
  }

  function seekSource(time: number) {
    const video = videoRef.current;
    if (!video || !project || progDur === 0) return;
    if (playMode === "render") {
      pendingPreview.current = { time, playing: true };
      setPlayMode("source");
      return;
    }
    video.currentTime = nextPreviewTime(time, cuts, project.sourceDuration);
    void video.play().catch(() => {});
  }

  function seekEdited(time: number) {
    const video = videoRef.current;
    if (!video || (playMode === "source" && progDur === 0)) return;
    if (playMode === "render") {
      video.currentTime = Math.min(project.lastRender?.duration || 0, time);
      clock.update(video.currentTime, !video.paused);
    } else {
      video.currentTime = nextPreviewTime(programToSource(cuts, time), cuts, project.sourceDuration);
      clock.update(Math.min(progDur, sourceToProgram(cuts, video.currentTime)), !video.paused);
    }
  }

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "Escape") { setSelection(new Set()); return; }
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selection.size > 0) {
        e.preventDefault();
        setDeleted([...selection], true);
      } else if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, project, locked]);

  useEffect(() => {
    return (window as any).descripto?.onEditCommand?.((command: string) => { if (command === "undo") undo(); else if (command === "redo") redo(); });
    // History commands use the current project and lock state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, locked]);

  // ── word selection via drag ──────────────────────────────────────────────
  function wordMouseDown(e: React.MouseEvent, idx: number) {
    if (e.button !== 0 || locked) return;
    dragging.current = true;
    rangeGesture.current = e.shiftKey;
    if (!e.shiftKey || selectionAnchor.current === null) selectionAnchor.current = idx;
    wordMouseEnter(idx);
  }
  function wordMouseEnter(idx: number) {
    if (!dragging.current || selectionAnchor.current === null) return;
    const anchor = selectionAnchor.current;
    if (anchor !== idx) rangeGesture.current = true;
    const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
    setSelection(new Set(words.slice(a, b + 1).filter(w => !hideCuts || !w.deleted).map(w => w.id)));
  }
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // ── actions ──────────────────────────────────────────────────────────────
  async function transcribe() {
    if (actionDisabled || saveQueue.isPending() || actionRunning.current) return;
    actionRunning.current = true;
    setBusy("Turning your recording into an editable transcript…");
    setError("");
    try {
      const r = await fetch(`/api/projects/${id}/transcribe`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionRunning.current = false; setBusy(null);
    }
  }

  // Reattach to an active export after navigation/reload, so Cancel stays available.
  useEffect(() => {
    let disposed = false;
    void fetch(`/api/projects/${id}/render`).then(r => r.json()).then(job => {
      if (disposed || !job.jobId) return;
      setRenderJobId(job.jobId);
      setRenderProg({ pct: job.progress || 0, stage: job.stage });
      setCancellingRender(job.status === "cancelling");
    }).catch(() => {});
    return () => { disposed = true; };
  }, [id]);

  useEffect(() => {
    if (!renderJobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${id}/render?jobId=${renderJobId}`);
        const job = await response.json();
        if (disposed) return;
        if (!response.ok) throw new Error(job.error || "Could not check export status.");
        if (["done", "error", "cancelled"].includes(job.status)) {
          if (job.status === "done") { await load(); if (disposed) return; setPlayMode("render"); setExportNotice("Export ready. Download your edited video below."); }
          else if (job.status === "cancelled") { setExportNotice("Export cancelled. Your edits are saved."); if (job.error) setError(job.error); }
          else setError(job.error || "Export failed.");
          setRenderProg(null); setRenderJobId(null); setCancellingRender(false);
          return;
        }
        setRenderProg({ pct: job.progress ?? 0, stage: job.stage || "Encoding" });
        setCancellingRender(job.status === "cancelling");
      } catch (error) {
        if (disposed) return;
        setError((error as Error).message);
        // A lost job after a server restart is terminal; network loss can recover.
        if (!(error instanceof TypeError)) { setRenderProg(null); setRenderJobId(null); setCancellingRender(false); return; }
      }
      if (!disposed) timer = setTimeout(poll, 500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [renderJobId, id, load]);

  async function stopExport(jobId = renderJobId) {
    cancelPending.current = true;
    setCancellingRender(true);
    if (!jobId) return;
    try {
      const response = await fetch(`/api/projects/${id}/render?jobId=${jobId}`, { method: "DELETE" });
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || "Could not cancel export. Try again.");
      if (job.status === "cancelled") {
        setRenderProg(null); setRenderJobId(null); setCancellingRender(false);
        setExportNotice("Export cancelled. Your edits are saved.");
        if (job.error) setError(job.error);
      }
    } catch (error) { setCancellingRender(false); setError((error as Error).message); }
  }

  async function render() {
    if (actionDisabled || saveQueue.isPending() || progDur === 0 || startingExport.current) return;
    startingExport.current = true;
    setError(""); setExportNotice(""); cancelPending.current = false;
    setRenderProg({ pct: 0, stage: "Starting" });
    try {
      const response = await fetch(`/api/projects/${id}/render`, { method: "POST" });
      const job = await response.json();
      if (!response.ok) throw new Error(job.error);
      setRenderJobId(job.jobId);
      if (cancelPending.current) void stopExport(job.jobId);
    } catch (error) { setRenderProg(null); setCancellingRender(false); setError((error as Error).message); }
    finally { startingExport.current = false; }
  }

  async function runReview() {
    if (actionDisabled || saveQueue.isPending() || actionRunning.current) return;
    actionRunning.current = true;
    setBusy("Gemini Flash is watching the rendered video…");
    setError("");
    try {
      const r = await fetch(`/api/projects/${id}/review`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setReview(j.report);
      setTab("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionRunning.current = false; setBusy(null);
    }
  }

  async function runAudit() {
    if (actionDisabled || saveQueue.isPending() || actionRunning.current) return;
    actionRunning.current = true;
    setBusy("Checking the transcript for corrections…");
    setError("");
    try {
      const r = await fetch(`/api/projects/${id}/audit`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setAudit(j.audit);
      setTab("audit");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionRunning.current = false; setBusy(null);
    }
  }

  async function acceptCorrection(wordId: string, suggested: string) {
    if (locked) return;
    snapshot();
    for (const w of project.words) if (w.id === wordId) w.text = suggested;
    if (audit) for (const c of audit.corrections) if (c.wordId === wordId) c.applied = true;
    setAudit(audit ? { ...audit } : null);
    refreshFromLocal(); persist();
  }

  async function runAgent() {
    if (actionDisabled || saveQueue.isPending() || actionRunning.current) return;
    actionRunning.current = true;
    if (!agentCmd.trim()) { actionRunning.current = false; return; }
    setBusy("Your assistant is editing the transcript…");
    setError("");
    snapshot();
    setAgentLog((l) => [...l, `▸ ${agentCmd}`]);
    try {
      const r = await fetch(`/api/projects/${id}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: agentCmd }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setAgentLog((l) => [...l, j.reply, `(${j.wordsDeleted} words cut · program now ${fmtTime(j.programDuration)})`, ""]);
      await load();
    } catch (e) {
      const message = e instanceof TypeError ? "Connection to Descripto was interrupted. Wait for it to reconnect, then retry your edit." : (e as Error).message;
      setAgentLog((l) => [...l, `✗ ${message}`, ""]);
      setError(message);
      // An interrupted assistant can have saved partial edits; show disk state.
      await load();
    } finally {
      actionRunning.current = false; setBusy(null);
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-14">
        <p className="text-[var(--text-dim)]">{error || "Loading…"}</p>
        <Link onClick={guardNavigation} href="/" className="mt-4 inline-block text-[var(--accent)] hover:underline">← back</Link>
      </main>
    );
  }

  const hasRender = !!project.lastRender;
  const videoSrc =
    playMode === "render" && hasRender
      ? `/api/projects/${id}/media?render=1&t=${project.lastRender!.renderedAt}`
      : `/api/projects/${id}/media`;

  const exportCurrent = !!project.lastRender && project.lastRender.studioSound === project.studioSound && JSON.stringify(project.lastRender.cuts) === JSON.stringify(cuts);
  const previewDuration = playMode === "render" && project.lastRender ? project.lastRender.duration : progDur;

  return (
    <main className="editor-shell">
      {/* ── top bar ── */}
      <a href="#transcript" className="skip-link">Skip to transcript</a>
      <header className="app-topbar editor-topbar">
        <Link onClick={guardNavigation} href="/" className="brand" title="All projects"><StudioMark /><span>descripto</span></Link>
        <div className="topbar-divider" />
        <Link onClick={guardNavigation} href="/" className="breadcrumb">Projects</Link><span className="muted">/</span>
        <span className="editor-project-name" title={project.name}>{project.name}</span>
        <div className="editor-top-actions">
          <Link onClick={guardNavigation} href={`/settings?returnTo=/editor/${id}`} className="icon-button" aria-label="Settings" title="Settings"><Icon name="settings" size={17} /></Link>
          <button onClick={undo} disabled={locked || !history.current.length} className="icon-button" aria-label="Undo" title="Undo (⌘Z)"><Icon name="undo" size={17} /></button>
          <button onClick={redo} disabled={locked || !future.current.length} className="icon-button" aria-label="Redo" title="Redo (⇧⌘Z)"><Icon name="redo" size={17} /></button>
          <span className={`save-state ${saveStatus}`} role="status">{saveStatus === "saved" ? "All changes saved" : saveStatus === "saving" ? "Saving…" : "Not saved"}</span>
          <span className="topbar-divider" />
          {project.transcribed && <a href={`/api/projects/${id}/srt`} onClick={e => { if (actionDisabled) e.preventDefault(); }} aria-disabled={actionDisabled} className="btn-ghost captions-link" title="Download SRT captions"><Icon name="text" size={16} /> Captions</a>}
          {renderProg && <button className="btn-danger" onClick={() => void stopExport()} disabled={cancellingRender}>{cancellingRender ? "Stopping…" : "Cancel export"}</button>}
          <button onClick={() => void exportCapcut()} disabled={!project.transcribed || actionDisabled || capcutBusy || progDur === 0 || !project.sourceWidth} className="btn-soft" title="Create a CapCut project with these cuts and open CapCut">{capcutBusy ? "Sending to CapCut…" : "Edit in CapCut"}</button>
          <button onClick={render} disabled={!project.transcribed || actionDisabled || progDur === 0 || !project.sourceWidth} className="btn-accent export-button"><Icon name="download" size={16} />{renderProg ? `Exporting ${renderProg.pct}%` : "Export video"}</button>
        </div>
      </header>

      {/* progress + status strips */}
      {saveStatus === "error" && <div className="error-banner" role="alert"><span>Edits are kept in this window but have not been saved. {saveError}</span><button className="btn-soft" onClick={() => saveQueue.retry()}>Retry save</button></div>}
      {exportNotice && <div className="server-status" role="status"><span>{exportNotice}</span><button className="btn-ghost" aria-label="Dismiss export notice" onClick={() => setExportNotice("")}><Icon name="close" size={14} /></button></div>}
      {serverStatus && <div className="server-status" role="status">
        <span>{serverStatus === "restarting" ? "Reconnecting to your local studio…" : serverStatus === "failed" ? "The local server could not restart. Close and reopen Descripto. Your saved projects are safe." : "Reconnected. Retry your last action if it did not finish."}</span>
        {serverStatus === "ready" && <button className="btn-ghost" aria-label="Dismiss connection notice" onClick={() => setServerStatus("")}><Icon name="close" size={14} /></button>}
      </div>}
      {renderProg && (
        <div className="shrink-0 bg-[#1c1c1c] px-4 pb-1.5">
          <div className="h-[3px] w-full overflow-hidden rounded bg-[#333]">
            <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${renderProg.pct}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-dim)]">{renderProg.stage}…</p>
        </div>
      )}
      {(busy || error) && (
        <div role="status" className={`shrink-0 px-4 py-1.5 text-[12px] ${error ? "bg-[#3a1d1d] text-[#ff9d97]" : "bg-[#1d2438] text-[#a9b8ff]"}`}>
          {error || busy}{error && <button className="btn-ghost" aria-label="Dismiss error" onClick={() => setError("")}><Icon name="close" size={14} /></button>}
        </div>
      )}

      <div className="editor-workspace">
        {/* ── left: script + timeline ── */}
        <section className="transcript-panel" aria-label="Transcript editor">
          <div className="panel-heading"><span><Icon name="text" size={16} /> Transcript</span><span className="panel-heading-meta">{words.filter(w => !w.deleted).length} words</span></div>
          <div className="transcript-tools">
            <label className="search-field"><Icon name="search" size={15} /><input aria-label="Find a word in transcript" placeholder="Find a word…" value={search} onChange={e => { setSearch(e.target.value); setMatchIndex(-1); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); findMatch(e.shiftKey ? -1 : 1); } }} />{search && <button onClick={() => setSearch("")} aria-label="Clear transcript search"><Icon name="close" size={14} /></button>}</label>
            {searchTerm && <span className="search-count" role="status">{matchIndex >= 0 && matches.length ? `${Math.min(matchIndex + 1, matches.length)} / ` : ""}{matches.length} matches</span>}
            {searchTerm && <><button className="icon-button" disabled={!matches.length} onClick={() => findMatch(-1)} aria-label="Previous match">↑</button><button className="icon-button" disabled={!matches.length} onClick={() => findMatch(1)} aria-label="Next match">↓</button></>}
            <button className="btn-ghost cuts-toggle" aria-pressed={!hideCuts} onClick={() => { setHideCuts(!hideCuts); setSelection(new Set()); }}><Icon name="eye" size={15} />{hideCuts ? "Show cuts" : "Hide cuts"}</button>
          </div>
          {/* script document */}
          <div className="script" id="transcript" tabIndex={-1}>
            <div className="document-title"><span className="eyebrow">THE SCRIPT</span><h1>{project.name}</h1><p>{project.transcribed ? `Click a word to play. Drag or Shift-click to select; Delete to cut.${project.transcriptEngine ? ` Transcribed by ${project.transcriptEngine}.` : ""}` : "Turn your recording into a script you can edit."}</p></div>
            {!project.transcribed ? (
              <div className="transcript-empty">
                <span className="empty-icon"><Icon name="wave" size={30} /></span><h2>Every edit starts with a word.</h2><p>Transcribe your recording to find, trim and refine your story.</p>
                <button onClick={transcribe} disabled={actionDisabled} className="btn-accent mt-5 px-6 py-2.5 text-[14px]">
                  {busy ? "Transcribing…" : "Create transcript"}
                </button>
                <p className="mt-3 text-[12px] text-[var(--text-dim)]">{fmtTime(project.sourceDuration)} of media · word-level</p>
              </div>
            ) : (
              <div className="script-paragraphs">
                {project.paragraphs.map((para) => {
                  const firstId = hideCuts ? para.wordIds.find(wid => !words[wordIndex.get(wid) ?? -1]?.deleted) : para.wordIds[0];
                  const first = words[wordIndex.get(firstId || "") ?? -1];
                  if (hideCuts && para.wordIds.every(wid => words[wordIndex.get(wid) ?? -1]?.deleted)) return null;
                  const last = words[wordIndex.get(para.wordIds[para.wordIds.length - 1]) ?? -1];
                  return (
                    <div key={para.id} className="script-paragraph">
                      <div className="paragraph-gutter">
                        <span className="paragraph-time">
                          {first && last ? `${fmtTime(sourceToProgram(cuts, first.start))}` : ""}
                        </span>
                      </div>
                      <p className="text-[var(--text)]">
                        {para.wordIds.map((wid) => {
                          const idx = wordIndex.get(wid) ?? -1;
                          if (idx < 0) return null;
                          const w = words[idx];
                          if (hideCuts && w.deleted) return null;
                          return (
                            <span
                              key={w.id}
                              id={`word-${w.id}`}
                              className={`word ${w.deleted ? "deleted" : ""} ${w.filler ? "filler" : ""} ${retakeIds.bad.has(w.id) ? "retake-bad" : retakeIds.good.has(w.id) ? "retake-good" : ""} ${activeWord.current === w.id ? "active" : ""} ${selection.has(w.id) ? "selected" : ""} ${matches[matchIndex]?.id === w.id ? "current-match" : ""} ${searchTerm && w.text.toLocaleLowerCase().includes(searchTerm) ? "search-match" : ""}`}
                              role="button"
                              tabIndex={w.id === tabStopWord ? 0 : -1}
                              onFocus={() => setFocusedWord(w.id)}
                              aria-label={`${w.text}${w.deleted ? ", cut" : ""}, ${fmtTime(sourceToProgram(cuts, w.start))}`}
                              onKeyDown={e => wordKeyDown(e, idx)}
                              onMouseDown={(e) => wordMouseDown(e, idx)}
                              onMouseEnter={() => wordMouseEnter(idx)}
                              onClick={() => !rangeGesture.current && selection.size <= 1 && seekSource(w.start)}
                            >
                              {w.text}{" "}
                            </span>
                          );
                        })}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* floating selection toolbar */}
          {project.transcribed && selection.size > 0 && (
            <div className="selection-toolbar pointer-events-none">
              <div className="selection-controls pointer-events-auto">
                <span className="pl-2 text-[12px] text-[var(--text-dim)]">{selection.size} selected</span>
                <button
                  disabled={locked || !words.some(w => selection.has(w.id) && !w.deleted)}
                  onClick={() => setDeleted([...selection], true)}
                  className="btn-danger"
                >
                  Delete ⌫
                </button>
                <button
                  disabled={locked || !words.some(w => selection.has(w.id) && w.deleted)}
                  onClick={() => setDeleted([...selection], false)}
                  className="btn-soft"
                >
                  Restore
                </button>
                <button className="icon-button" aria-label="Clear selection" onClick={() => setSelection(new Set())}><Icon name="close" size={14} /></button>
              </div>
            </div>
          )}

          {project.transcribed && <EditedTimeline clock={timelineClock} onToggle={() => { const video = videoRef.current; if (!video) return; if (!video.paused) { video.pause(); return; } const elapsed = timelineClock.getSnapshot().time; const time = elapsed >= progDur - 0.025 ? 0 : elapsed; if (playMode === "render") { pendingPreview.current = { time: programToSource(cuts, time), playing: true }; setPlayMode("source"); } else { seekEdited(time); void video.play().catch(() => {}); } }} videoRef={videoRef} duration={progDur} seek={time => {
            if (playMode === "render") {
              pendingPreview.current = { time: programToSource(cuts, time), playing: !videoRef.current?.paused };
              setPlayMode("source");
            } else seekEdited(time);
          }} words={words} cuts={cuts} sourceDuration={project.sourceDuration} />}

        </section>

        {/* ── right: player + actions ── */}
        <aside className="inspector">
          <button type="button" className="panel-heading panel-toggle" aria-expanded={previewOpen} onClick={() => setPreviewOpen(o => !o)}><span><Icon name="film" size={16} /> Preview</span><span className="panel-heading-meta">{project.sourceWidth && project.sourceHeight ? `${project.sourceWidth} × ${project.sourceHeight}` : "Media"}<Icon name="chevron" size={14} style={{ transform: previewOpen ? "none" : "rotate(-90deg)" }} /></span></button>
          {/* export download sits outside the collapsible preview so it stays reachable */}
          {hasRender && <div className="export-download export-download-top"><span>{exportCurrent ? "Export matches current cuts" : "Last export · earlier edit"}</span><a className="btn-soft" href={`/api/projects/${id}/media?render=1&download=1`}><Icon name="download" size={14} /> Download MP4</a></div>}
          {/* player: collapsed with CSS only, so the video stays mounted and word clicks still play */}
          <div className="preview-panel" hidden={!previewOpen}>
            <div className="preview-tabs">
              <button
                onClick={() => switchPreview("source")}
                aria-pressed={playMode === "source"}
              >
                Live preview
              </button>
              <button
                onClick={() => hasRender && switchPreview("render")}
                disabled={!hasRender}
                aria-pressed={playMode === "render"}
              >
                Last export {hasRender ? `· ${fmtTime(project.lastRender!.duration)}` : ""}
              </button>
            </div>
            <div className="video-player">
              <video ref={videoRef} src={videoSrc} preload="auto" playsInline className="preview-video" onLoadedData={() => setMediaError(false)} onError={() => setMediaError(true)} />
              <VideoControls clock={clock} videoRef={videoRef} duration={previewDuration} seek={seekEdited} />
            </div>
            {mediaError && <div className="preview-error" role="alert"><span>Preview could not load. Reconnect or check the original media file.</span><button className="btn-soft" onClick={() => videoRef.current?.load()}>Retry preview</button></div>}
            <p className="mt-2 text-[11px] text-[var(--text-dim)]">
              {playMode === "source" ? "Your cuts are applied live. Ready to export anytime." : exportCurrent ? "Watching your current export." : "Earlier export. Switch to Live preview to see your latest cuts."}
            </p>
            {!project.sourceWidth && <p className="muted text-[11px]">Audio recordings support transcription and captions. MP4 export requires a video.</p>}
          </div>

          {/* actions panel */}
          <div className="inspector-tools">
            <h2 className="tools-heading">Refine your recording</h2>

            {/* Studio Sound card */}
            <div className="card refinement-card flex items-center justify-between">
              <div className="pr-3">
                <p className="text-[13px] font-medium">Studio Sound</p>
                <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-dim)]">Reduce background noise and balance your voice on export. <Link onClick={guardNavigation} href={`/settings?returnTo=/editor/${id}`} className="underline">Audio settings</Link></p>
              </div>
              <button
                type="button" role="switch" aria-label="Studio Sound" aria-checked={project.studioSound}
                className={`switch ${project.studioSound ? "on" : ""}`}
                disabled={locked}
                onClick={() => { snapshot(); project.studioSound = !project.studioSound; refreshFromLocal(); persist(); }}
              />
            </div>

            {/* Fillers card */}
            <div className="card refinement-card">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium">Filler words</p>
                <span className="filler-count">{fillerCount}</span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-dim)]">Trim the “um”, “uh” and “you know” from your story.</p>
              <div className="mt-2.5 flex gap-2">
                <button onClick={() => fillers(true)} disabled={!fillerCount || actionDisabled} className="btn-soft px-3 py-1 text-[12px]">Remove all</button>
                <button onClick={() => fillers(false)} disabled={!words.some(w => w.filler && w.deleted) || actionDisabled} className="btn-soft px-3 py-1 text-[12px]">Restore all</button>
              </div>
            </div>

            {/* Repeated takes card (ADR-006) */}
            <div className="card refinement-card">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium">Repeated takes</p>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={runAiCheck} disabled={actionDisabled || aiCheck.busy} className="btn-soft px-2 py-0.5 text-[11px]" title="Ask Claude to find repeats the local check missed">{aiCheck.busy ? "Checking…" : "AI check"}</button>
                  {retakes.length > 1 && <button type="button" onClick={() => setDeleted(retakes.flatMap((r) => r.bad.wordIds), true)} disabled={actionDisabled} className="btn-soft px-2 py-0.5 text-[11px]">Cut all</button>}
                  <span className="filler-count">{retakes.length}</span>
                </div>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-dim)]">Earlier attempts in red, the take that stays in green. Nothing is cut until you choose.</p>
              {aiCheck.note && <p className="mt-1 text-[11px] text-[var(--text-dim)]" role="status">{aiCheck.note}</p>}
              {retakes.length > 0 && <ul className="retake-list mt-2 space-y-1.5">
                {retakes.map((r) => (
                  <li key={r.bad.wordIds[0]} className="flex items-start gap-2 text-[11px]">
                    <button type="button" className="retake-text min-w-0 flex-1 text-left" title={`${r.reason ? `AI: ${r.reason}\n` : ""}Keeps: ${r.good.text}`} onClick={() => seekSource(r.bad.start)}>
                      <span className="tabular-nums text-[var(--text-dim)]">{fmtTime(sourceToProgram(cuts, r.bad.start))}</span> {r.kind === "ai" && <span className="retake-ai-tag">AI</span>} <span className="retake-bad-text">{r.bad.text.length > 70 ? r.bad.text.slice(0, 70) + "…" : r.bad.text}</span>
                    </button>
                    <button type="button" onClick={() => setDeleted(r.bad.wordIds, true)} disabled={actionDisabled} className="btn-soft shrink-0 px-2 py-0.5 text-[11px]">Cut</button>
                  </li>
                ))}
              </ul>}
            </div>

            {/* Tighten pauses card (ADR-004) */}
            <div className="card refinement-card">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-medium">Tighten pauses</p>
                <button
                  type="button" role="switch" aria-label="Tighten pauses" aria-checked={pauseSettings.enabled}
                  className={`switch ${pauseSettings.enabled ? "on" : ""}`}
                  disabled={actionDisabled || !project.pauses}
                  onClick={() => setPauses({ ...pauseSettings, enabled: !pauseSettings.enabled })}
                />
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-dim)]">
                {!project.pauses ? "Pauses are not analyzed for this project yet." : `${tightened.length} pause${tightened.length === 1 ? "" : "s"} · ${tightenedSec.toFixed(1)}s ${pauseSettings.enabled ? "removed" : "to remove"}. Only stretches quieter than speech are shortened.`}
              </p>
              <div className="mt-2.5 flex gap-3 text-[11px] text-[var(--text-dim)]">
                <label className="flex items-center gap-1">Pauses over
                  <input type="number" min={0.3} max={60} step={0.1} value={pauseSettings.minGap} disabled={actionDisabled || !project.pauses} className="w-14 rounded border border-[var(--border)] bg-transparent px-1 py-0.5"
                    onChange={(e) => setPauses({ ...pauseSettings, minGap: Number(e.target.value) })} />s</label>
                <label className="flex items-center gap-1">Keep
                  <input type="number" min={0} max={30} step={0.05} value={pauseSettings.margin} disabled={actionDisabled || !project.pauses} className="w-14 rounded border border-[var(--border)] bg-transparent px-1 py-0.5"
                    onChange={(e) => setPauses({ ...pauseSettings, margin: Number(e.target.value) })} />s each side</label>
              </div>
            </div>

            {/* AI tabs */}
            <div className="assistant-tabs" role="tablist" aria-label="Editing assistant">
              {(["agent", "review", "audit"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  tabIndex={tab === t ? 0 : -1}
                  onKeyDown={e => { const tabs: Tab[] = ["agent", "review", "audit"]; const direction = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (direction) { e.preventDefault(); const next = tabs[(tabs.indexOf(t) + direction + tabs.length) % tabs.length]; setTab(next); document.getElementById(`tab-${next}`)?.focus(); } }}
                  role="tab" aria-selected={tab === t} aria-controls={`panel-${t}`} id={`tab-${t}`}
                >
                  <Icon name={t === "review" ? "eye" : t === "audit" ? "check" : "spark"} size={14} />{t === "review" ? "Review" : t === "audit" ? "Proofread" : "Assistant"}
                </button>
              ))}
            </div>

            {tab === "review" && (
              <div className="assistant-content" role="tabpanel" id="panel-review" aria-labelledby="tab-review">
                <button onClick={runReview} disabled={!hasRender || actionDisabled} className="btn-accent mb-2.5 w-full px-3 py-2 text-[12.5px]">
                  Review rendered video
                </button>
                {!hasRender && <p className="text-[11px] text-[var(--text-dim)]">Render your edit first. The review checks the finished video for rough cuts and audio issues.</p>}
                {review && (
                  <div className="space-y-2">
                    <div className="card review-summary p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">Overall</p>
                      <p className="mt-1 text-[12.5px] leading-relaxed">{review.overall}</p>
                    </div>
                    <p className="text-[11.5px] leading-relaxed text-[var(--text-dim)]">{review.summary}</p>
                    {review.issues.length === 0 && <p className="text-[12px] text-[#4ac267]">No issues reported.</p>}
                    {review.issues.map((iss, i) => (
                      <div
                        key={i}
                        className={`card p-2.5 ${iss.severity === "error" ? "border-[#6d2f2b]" : iss.severity === "warning" ? "border-[#6d5a24]" : ""}`}
                      >
                        <div className="flex items-center justify-between">
                          <button className="btn-ghost font-mono text-[11px] text-[var(--accent)]" disabled={!hasRender || review.reviewedFile !== project.lastRender?.file} aria-label={`Preview review issue at ${fmtTime(iss.timestamp)}`} onClick={() => switchPreview("render", iss.timestamp)}>{fmtTime(iss.timestamp)}</button>
                          <span className="rounded-full bg-[#2e2e2e] px-2 py-0.5 text-[10px] text-[var(--text-dim)]">{iss.kind}</span>
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed">{iss.note}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === "audit" && (
              <div className="assistant-content" role="tabpanel" id="panel-audit" aria-labelledby="tab-audit">
                <button onClick={runAudit} disabled={!project.transcribed || actionDisabled} className="btn-accent mb-2.5 w-full px-3 py-2 text-[12.5px]">
                  Check transcript
                </button>
                {audit && (
                  <div className="space-y-2">
                    <p className="card p-3 text-[12px] leading-relaxed text-[var(--text-dim)]">{audit.notes}</p>
                    {audit.corrections.length === 0 && <p className="text-[12px] text-[#4ac267]">Transcript is clean.</p>}
                    {audit.corrections.map((c, i) => (
                      <div key={i} className="card p-2.5">
                        <p className="text-[12.5px]">
                          <span className="text-[#ff9d97] line-through">{c.current}</span>
                          {" → "}
                          <span className="text-[#4ac267]">{c.suggested}</span>
                        </p>
                        <p className="mt-0.5 text-[10.5px] text-[var(--text-dim)]">{Math.round(c.confidence * 100)}% · {c.reason}</p>
                        {!c.applied ? (
                          <button disabled={locked} onClick={() => acceptCorrection(c.wordId, c.suggested)} className="btn-soft mt-1.5 px-3 py-1 text-[11px]">
                            Accept
                          </button>
                        ) : (
                          <span className="text-[11px] text-[#4ac267]">✓ applied</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === "agent" && (
              <div className="assistant-content" role="tabpanel" id="panel-agent" aria-labelledby="tab-agent">
                <p className="mb-2 text-[11px] leading-snug text-[var(--text-dim)]">
                  Describe the edit. Your assistant will make the cuts in your transcript.
                </p>
                {!agentLog.length && <div className="assistant-suggestions"><button onClick={() => setAgentCmd("Remove all filler words from this transcript.")}>Remove filler words <Icon name="arrow" size={13} /></button><button onClick={() => setAgentCmd("Find repeated points and suggest cuts before making any changes.")}>Find repeated points <Icon name="arrow" size={13} /></button></div>}
                <div className="edit-composer">
                <textarea
                  aria-label="Describe an edit"
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void runAgent(); } }}
                  value={agentCmd}
                  onChange={(e) => setAgentCmd(e.target.value)}
                  placeholder="What would you like to change?"
                  className="w-full resize-none"
                />
                <div className="composer-actions"><button onClick={runAgent} disabled={actionDisabled || !project.transcribed || !agentCmd.trim()} className="btn-accent">
                  Apply edit <Icon name="arrow" size={13} />
                </button></div></div>
                <div className="agent-log mt-3 space-y-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-dim)]">
                  {agentLog.map((l, i) => (
                    <p key={i} className={l.startsWith("✗") ? "text-[#ff9d97]" : l.startsWith("▸") ? "text-[var(--accent)]" : ""}>{l}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

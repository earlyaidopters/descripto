"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon, StudioMark } from "@/components/studio-icon";
import { fmtTime } from "@/lib/types";

interface Proj { id: string; name: string; createdAt: string; duration: number; transcribed: boolean }

export default function Home({ initialProjects }: { initialProjects: Proj[] }) {
  const [projects, setProjects] = useState<Proj[]>(initialProjects);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dropping, setDropping] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const failedFile = useRef<File | null>(null);
  const importing = useRef(false);
  const dragDepth = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/projects");
      if (!r.ok) throw new Error("Could not load your projects. Try again.");
      const j = await r.json();
      setProjects(j.projects || []);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function importFile(f: File) {
    if (importing.current) return;
    if (!/\.(mp4|mov|m4v|mkv|webm|mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name) && !/^(video|audio)\//.test(f.type)) {
      setError("Choose a video or audio file, such as MP4, MOV, MP3 or WAV."); return;
    }
    failedFile.current = f;
    importing.current = true;
    setBusy(true); setError("");
    try {
      const localPath = (window as any).descripto?.pathForFile?.(f);
      const r = localPath
        ? await fetch(`/api/projects/local?path=${encodeURIComponent(localPath)}&name=${encodeURIComponent(f.name)}`, { method: "POST" })
        : await fetch(`/api/projects?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      const j = await r.json();
      if (!r.ok || !j.id) throw new Error(j.error || "Could not import this file. Try again.");
      window.location.href = `/editor/${j.id}`;
    } catch (e) { setError((e as Error).message); setBusy(false); importing.current = false; }
  }

  // Deletes the project folders (edits, transcript, renders and descripto's copy of the
  // media). The original recording and CapCut exports live elsewhere and are not touched.
  async function removeProjects(list: Proj[]) {
    if (!list.length || deleting) return;
    const what = list.length === 1 ? `"${list[0].name}"` : `${list.length} projects`;
    if (!window.confirm(`Delete ${what}? This removes the edits, transcript, exports and descripto's copy of the video. Your original recording is not touched. This cannot be undone.`)) return;
    setDeleting(true); setError("");
    const failed: string[] = [];
    for (const p of list) {
      try { const r = await fetch(`/api/projects/${p.id}`, { method: "DELETE" }); if (!r.ok) failed.push(p.name); }
      catch { failed.push(p.name); }
    }
    await load();
    setDeleting(false);
    if (failed.length) setError(`Could not delete: ${failed.join(", ")}.`);
  }

  const visible = projects.filter(p => p.name.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || p.transcribed))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return (
    <main className="library" onDragEnter={e => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) { dragDepth.current++; setDropping(true); } }}
      onDragOver={e => e.preventDefault()} onDragLeave={e => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
      onDrop={e => { e.preventDefault(); dragDepth.current = 0; setDropping(false); const f = e.dataTransfer.files?.[0]; if (f) void importFile(f); }}>
      <a className="skip-link" href="#library-content">Skip to projects</a>
      <header className="app-topbar library-topbar">
        <Link href="/" className="brand"><StudioMark /><span>descripto</span></Link>
        <div className="topbar-divider" /><span className="muted text-[12px]">Your local studio</span>
        <span className="local-indicator"><i /> Files stored on this Mac</span>
        <Link href="/settings" className="icon-button" aria-label="Settings" title="Settings"><Icon name="settings" size={17} /></Link>
      </header>
      <div className="library-content" id="library-content">
        {error && <div className="error-banner" role="alert">{error}<button className="btn-ghost" onClick={() => { setError(""); if (failedFile.current) void importFile(failedFile.current); else void load(); }}>Retry</button></div>}
        <section className="project-library" aria-labelledby="projects-heading">
          <div className="library-heading">
            <h1 id="projects-heading">Projects <span>{projects.length}</span></h1>
            <div className="library-actions">
              <label className="search-field"><Icon name="search" size={16} /><input aria-label="Search projects" placeholder="Find a project…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery("")}><Icon name="close" size={14} /></button>}</label>
              {visible.length > 0 && <button className="btn-soft new-project-button" onClick={() => void removeProjects(visible)} disabled={busy || deleting} title={query || filter !== "all" ? "Delete the projects shown" : "Delete all projects"}>{deleting ? "Deleting…" : query || filter !== "all" ? `Clear ${visible.length} shown` : "Clear list"}</button>}
              <button className="btn-accent new-project-button" onClick={() => fileRef.current?.click()} disabled={busy}><Icon name={busy ? "wave" : "plus"} size={17} />{busy ? "Importing…" : "New project"}</button>
            </div>
          </div>
          <div className="library-filters"><div className="filter-tabs"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All projects</button><button aria-pressed={filter === "ready"} onClick={() => setFilter("ready")}>Ready to edit</button></div><div className="sort-control"><select aria-label="Sort projects" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Newest first</option><option value="name">Name A–Z</option></select><Icon name="chevron" size={12} /></div></div>
          <div className="project-grid">
            {visible.map(p => (
              <div key={p.id} className="project-card-wrap">
              <Link href={`/editor/${p.id}`} className="project-card">
                <div className="project-thumbnail"><Icon name="wave" size={40} /><video src={`/api/projects/${p.id}/media#t=0.1`} preload="metadata" muted playsInline aria-label={`${p.name} preview`} /><span className="project-duration">{fmtTime(p.duration)}</span><span className="project-open"><Icon name="arrow" /></span></div>
                <div className="project-info"><h3>{p.name}</h3><div className="project-meta"><span>{new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span><span className={`project-status ${p.transcribed ? "ready" : ""}`}><i />{p.transcribed ? "Ready to edit" : "Needs transcript"}</span></div></div>
              </Link>
              <button className="project-delete" aria-label={`Delete ${p.name}`} title="Delete project" disabled={deleting} onClick={() => void removeProjects([p])}><Icon name="close" size={14} /></button>
              </div>
            ))}
          </div>
          {!visible.length && <div className="empty-library"><Icon name={projects.length ? "search" : "film"} size={32} /><h3>{projects.length ? "No matching projects" : "Your next story starts here"}</h3><p>{projects.length ? "Try another name or switch to All projects." : "Import your first recording to start editing with text."}</p><button className="btn-soft" onClick={() => { if (projects.length) { setQuery(""); setFilter("all"); } else fileRef.current?.click(); }}>{projects.length ? "Clear filters" : "Choose a recording"}</button></div>}
        </section>

      </div>
      {(dropping || busy) && <div className={`drop-overlay ${busy ? "is-busy" : ""}`} role="status"><Icon name={busy ? "wave" : "plus"} size={40} /><h2>{busy ? "Opening your recording…" : "Drop it. Make it yours."}</h2><p>{busy ? "Preparing your project" : "Release to create a new project"}</p></div>}
      <input ref={fileRef} type="file" accept="video/*,audio/*,.mkv,.flac" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
    </main>
  );
}

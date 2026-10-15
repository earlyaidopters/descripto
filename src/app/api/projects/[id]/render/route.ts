import { preferences } from "@/lib/settings";
import { serviceKey } from "@/lib/env";
import { finishWithAuphonic } from "@/lib/auphonic";
import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { loadProject, rendersDir, saveProject } from "@/lib/store";
import { computeKeeps, deriveCuts, programDuration } from "@/lib/edl";
import { probe, renderProgram } from "@/lib/ffmpeg";
import { activeRender, findRender, startRender, cancelRender } from "@/lib/render-jobs";

export const runtime = "nodejs";
export const maxDuration = 3600;
type Context = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Context) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const active = activeRender(id);
  if (active) return NextResponse.json({ jobId: active.job.id });
  if (!p.transcribed) return NextResponse.json({ error: "transcribe first" }, { status: 400 });
  const cuts = deriveCuts(p);
  const keeps = computeKeeps(cuts, p.sourceDuration);
  if (!keeps.length) return NextResponse.json({ error: "nothing to keep" }, { status: 400 });
  const useAuphonic = p.studioSound && preferences().audioProcessor === "auphonic";
  const audioKey = useAuphonic ? serviceKey("auphonic") : "";
  const total = programDuration(cuts, p.sourceDuration);
  const task = startRender(id, async (job, signal) => {
    const out = path.join(rendersDir(id), `${job.id}.mp4`);
    try {
      signal.throwIfAborted();
      const info = await probe(p.sourceFile, signal);
      const cloudAudio = useAuphonic && info.hasAudio;
      if (cloudAudio && !audioKey) throw new Error("Add an Auphonic key in Settings → Connections or choose built-in Studio Sound.");
      await renderProgram(p.sourceFile, out, keeps, { studioSound: p.studioSound && !cloudAudio, hasAudio: info.hasAudio, frameRate: info.frameRate, total, signal }, (frac, stage) => {
        if (signal.aborted) return;
        job.progress = Math.round(frac * (cloudAudio ? 65 : 100)); job.stage = stage;
      });
      if (cloudAudio) {
        signal.throwIfAborted(); job.progress = 70;
        await finishWithAuphonic(out, audioKey, stage => { if (!signal.aborted) job.stage = stage; }, signal);
      }
      signal.throwIfAborted();
      const rendered = await probe(out, signal);
      signal.throwIfAborted();
      const latest = loadProject(id) || p;
      latest.lastRender = { file: out, duration: rendered.duration, renderedAt: new Date().toISOString(), studioSound: p.studioSound, cutCount: cuts.length, cuts };
      saveProject(latest);
      job.output = out;
    } catch (error) {
      try { fs.unlinkSync(out); } catch {}
      throw error;
    }
  });
  return NextResponse.json({ jobId: task.job.id });
}

export async function GET(req: NextRequest, ctx: Context) {
  const { id } = await ctx.params;
  const jobId = req.nextUrl.searchParams.get("jobId");
  const task = jobId ? findRender(id, jobId) : activeRender(id);
  if (jobId && !task) return NextResponse.json({ error: "This export was interrupted when the studio restarted. Your edits are saved." }, { status: 404 });
  if (!task) return NextResponse.json({ lastRender: loadProject(id)?.lastRender || null, job: null });
  const { output, ...job } = task.job;
  return NextResponse.json({ ...job, jobId: job.id, output: output && job.status === "done" ? `/api/projects/${id}/media?render=1` : undefined });
}

export async function DELETE(req: NextRequest, ctx: Context) {
  const { id } = await ctx.params;
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "Choose an export to cancel." }, { status: 400 });
  const job = await cancelRender(id, jobId);
  if (!job) return NextResponse.json({ error: "This export is no longer running." }, { status: 404 });
  return NextResponse.json({ status: job.status, error: job.error });
}

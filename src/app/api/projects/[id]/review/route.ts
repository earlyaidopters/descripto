import { NextRequest, NextResponse } from "next/server";
import { loadProject, saveProject } from "@/lib/store";
import { deriveCuts } from "@/lib/edl";
import { reviewVideo } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 600;

// POST /api/projects/:id/review — Gemini Flash watches the rendered video back
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!p.lastRender) return NextResponse.json({ error: "render first — Gemini reviews the rendered program" }, { status: 400 });

  try {
    const cuts = deriveCuts(p);
    const report = await reviewVideo(p.lastRender.file, p.lastRender.duration, cuts.length);
    p.lastReview = report;
    saveProject(p);
    return NextResponse.json({ report });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  return NextResponse.json({ review: p?.lastReview || null });
}

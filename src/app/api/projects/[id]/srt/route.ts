import { NextRequest, NextResponse } from "next/server";
import { loadProject } from "@/lib/store";
import { deriveCuts, toSRT } from "@/lib/edl";

export const runtime = "nodejs";

// GET /api/projects/:id/srt — download captions for the current edit
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p || !p.transcribed) return new NextResponse("not found", { status: 404 });
  const cuts = deriveCuts(p);
  const srt = toSRT(p.words, cuts);
  const name = p.name.replace(/[^\w-]+/g, "_") + ".srt";
  return new NextResponse(srt, {
    headers: {
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}

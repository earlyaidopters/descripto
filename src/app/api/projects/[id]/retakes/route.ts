import { NextRequest, NextResponse } from "next/server";
import { loadProject, saveProject } from "@/lib/store";
import { deriveCuts } from "@/lib/edl";
import { segmentWords } from "@/lib/retakes";
import { AI_RETAKE_MODEL, runAiRetakeCheck } from "@/lib/retakes-ai";

export const runtime = "nodejs";
export const maxDuration = 600;

// POST /api/projects/:id/retakes: AI check for repeated takes (ADR-007). Proposes only; stores the
// pairs by word id on the project, and the editor re-validates them against the current edit.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const segments = segmentWords(p.words, p.pauses, deriveCuts(p));
  if (segments.length < 2) return NextResponse.json({ error: "not enough transcript to check" }, { status: 400 });
  try {
    const pairs = await runAiRetakeCheck(segments);
    const fresh = loadProject(id) ?? p; // the edit may have changed while the model ran
    fresh.aiRetakes = { at: new Date().toISOString(), model: AI_RETAKE_MODEL, pairs };
    saveProject(fresh);
    return NextResponse.json({ aiRetakes: fresh.aiRetakes });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

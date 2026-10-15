import { NextRequest, NextResponse } from "next/server";
import { loadProject, projectDir, saveProject } from "@/lib/store";
import { buildParagraphs, markFillers } from "@/lib/edl";
import { transcribe } from "@/lib/transcribe";

export const runtime = "nodejs";
export const maxDuration = 600;

// POST /api/projects/:id/transcribe — transcribe the source, word-level
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const result = await transcribe(p.sourceFile, projectDir(p.id));
    if (result.words.length === 0) throw new Error("no words transcribed — is there speech in this file?");
    markFillers(result.words);
    p.words = result.words;
    p.paragraphs = buildParagraphs(result.words);
    p.transcribed = true;
    p.transcriptEngine = result.engine;
    p.pauses = result.pauses;
    p.pausesVersion = result.pausesVersion;
    saveProject(p);
    return NextResponse.json({ ok: true, engine: result.engine, wordCount: result.words.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

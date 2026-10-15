import { isRemoveFillersCommand, removeDetectedFillers, assistantResultError } from "@/lib/assistant-command";
import { preferences } from "@/lib/settings";
import { anthropicKey, anthropicBaseUrl } from "@/lib/env";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadProject, projectDir, saveProject, statePath } from "@/lib/store";
import { deriveCuts, markFillers, programDuration } from "@/lib/edl";

export const runtime = "nodejs";
export const maxDuration = 900;

// POST /api/projects/:id/agent — headless Claude Agent SDK editing session.
// The agent gets ONE scoped MCP server (descript-edit) as its tools and
// performs the requested edit by mutating the transcript, then reports back.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!p.transcribed) return NextResponse.json({ error: "transcribe first" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const command = body?.command;
  if (typeof command !== "string" || !command.trim() || command.length > 10000) return NextResponse.json({ error: "missing command" }, { status: 400 });

  if (isRemoveFillersCommand(command)) {
    const wordsDeleted = removeDetectedFillers(p.words);
    saveProject(p);
    return NextResponse.json({
      reply: wordsDeleted ? `Removed ${wordsDeleted} detected filler word${wordsDeleted === 1 ? "" : "s"}. You can undo this edit or restore individual words.` : "There are no remaining detected filler words to remove.",
      wordsDeleted, programDuration: programDuration(deriveCuts(p), p.sourceDuration), turns: 0,
    });
  }
  const before = p.words.filter((w) => !w.deleted).length;

  const agentEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  const config = preferences();
  delete agentEnv.ANTHROPIC_API_KEY;
  if (config.agentAuth === "key") {
    const key = anthropicKey();
    if (!key) return NextResponse.json({ error: "Add your Anthropic API key in Settings → Connections." }, { status: 400 });
    agentEnv.ANTHROPIC_API_KEY = key;
    agentEnv.ANTHROPIC_BASE_URL = anthropicBaseUrl();
    delete agentEnv.ANTHROPIC_AUTH_TOKEN;
    delete agentEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }

  let finalText = "";
  let sessionId: string | undefined;
  let turns = 0;

  try {
    for await (const event of query({
      prompt: command,
      options: {
        cwd: projectDir(p.id),
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 40,
        model: config.agentModel,
        tools: [],
        allowedTools: ["mcp__descript__*"],
        env: agentEnv,
        systemPrompt: `You are the AI editing brain of a local Descript-style video editor. You edit VIDEO by editing the TRANSCRIPT: marking words deleted cuts them from the rendered program. Use only your descript-edit MCP tools. Always read the relevant transcript part first (read_transcript / find_text), then edit precisely (delete_words / delete_time_range / restore_words / remove_filler_words), then verify. Delete only words that serve the user's request; when unsure about meaning, prefer keeping content. Finish with a short summary of exactly what you cut and roughly how much time you saved.`,
        mcpServers: {
          descript: {
            command: process.execPath,
            args: [path.join(process.cwd(), "mcp", "edit-mcp-server.mjs")],
            env: {
              ...process.env,
              DESCRIPT_STATE: statePath(p.id),
              DESCRIPT_PROJECT_DIR: projectDir(p.id),
            },
          },
        },
      },
    }) as AsyncIterable<Record<string, unknown>>) {
      const ev = event as Record<string, unknown>;
      if (ev["type"] === "system" && ev["subtype"] === "init") {
        sessionId = ev["session_id"] as string;
      }
      if (ev["type"] === "assistant") {
        turns++;
      }
      if (ev["type"] === "result") {
        const error = assistantResultError(ev);
        if (error) throw new Error(error);
        finalText = String(ev["result"] ?? "");
      }
    }
  } catch (e) {
    return NextResponse.json({ error: `agent failed: ${(e as Error).message}` }, { status: 500 });
  }

  // Reload mutated state (the MCP server wrote to state.json)
  const updated = loadProject(p.id);
  if (updated) {
    markFillers(updated.words);
    saveProject(updated);
  }
  const after = updated ? updated.words.filter((w) => !w.deleted).length : before;
  const cuts = updated ? deriveCuts(updated) : deriveCuts(p);

  return NextResponse.json({
    reply: finalText || "(agent finished without a summary)",
    sessionId,
    turns,
    wordsDeleted: Math.max(0, before - after),
    programDuration: updated ? programDuration(cuts, updated.sourceDuration) : 0,
  });
}

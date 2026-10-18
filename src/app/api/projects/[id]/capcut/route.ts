import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { loadProject } from "@/lib/store";
import { deriveCuts } from "@/lib/edl";

export const runtime = "nodejs";
export const maxDuration = 300;

const CAPCUT_EXE = process.env.CAPCUT_EXE || "C:\\Users\\carlo.MAIN-PC\\AppData\\Local\\CapCut\\Apps\\CapCut.exe";

function run(bin: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// POST /api/projects/:id/capcut: write the current edit as a new CapCut project and open CapCut
// (ADR-008). CapCut reads its Projects folder only at start, so it must be closed first.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = loadProject(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!p.sourceWidth) return NextResponse.json({ error: "CapCut export needs a video" }, { status: 400 });

  const running = await run("tasklist.exe", ["/FI", "IMAGENAME eq CapCut.exe", "/NH"]);
  if (/CapCut\.exe/i.test(running.stdout)) return NextResponse.json({ error: "Close CapCut first: it only picks up new projects when it starts." }, { status: 409 });

  const req = { source: p.sourceFile, name: p.name, cuts: deriveCuts(p).map((c) => [c.start, c.end]) };
  const out = await run("python3", [path.join(process.cwd(), "scripts", "capcut_export.py")], JSON.stringify(req));
  let result: { project?: string; video?: string; clips?: number; warnings?: string[]; error?: string };
  try { result = JSON.parse(out.stdout.trim().split("\n").pop() || "{}"); } catch { result = { error: `export failed: ${(out.stderr || out.stdout).trim().slice(0, 300)}` }; }
  if (result.error || !result.project) return NextResponse.json({ error: result.error || "export failed" }, { status: 500 });

  const launch = await run("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath '${CAPCUT_EXE.replace(/'/g, "''")}'`]);
  return NextResponse.json({ ...result, name: path.basename(result.project), launched: launch.code === 0 });
}

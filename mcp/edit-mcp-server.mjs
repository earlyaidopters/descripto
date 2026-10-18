#!/usr/bin/env node
// ── Descript-clone MCP edit server ─────────────────────────────────────────
// Spawned by the Claude Agent SDK (headless) with env:
//   DESCRIPT_STATE = absolute path to the project's state.json
// Exposes scoped transcript-editing tools so the agent can edit the video by
// editing the transcript — and nothing else. No filesystem access, no shell.

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const STATE_PATH = process.env.DESCRIPT_STATE;
if (!STATE_PATH || !fs.existsSync(STATE_PATH)) {
  console.error("DESCRIPT_STATE not set or missing");
  process.exit(1);
}

function load() {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
}

function save(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

const fmt = (w) => {
  let s = `${w.id}|${w.start.toFixed(2)}-${w.end.toFixed(2)}|${w.text}`;
  if (w.deleted) s += "|D";
  if (w.filler) s += "|F";
  return s;
};

function cutsOf(words) {
  const del = words.filter((w) => w.deleted);
  return del.length;
}

const PAGE = 300;

const server = new McpServer({ name: "descript-edit", version: "1.0.0" });

server.registerTool(
  "project_overview",
  {
    title: "Project overview",
    description: "Project name, durations (source vs current program), word/cut/filler counts.",
    inputSchema: {},
  },
  async () => {
    const p = load();
    const kept = p.words.filter((w) => !w.deleted);
    const program = kept.reduce((a, w) => a + (w.end - w.start), 0);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          name: p.name,
          sourceDuration: +p.sourceDuration.toFixed(1),
          approxProgramDuration: +program.toFixed(1),
          wordCount: p.words.length,
          keptWords: kept.length,
          deletedWords: cutsOf(p.words),
          fillerWords: p.words.filter((w) => w.filler).length,
          studioSound: p.studioSound,
          tightenPauses: p.tightenPauses ?? { enabled: false },
          transcribed: p.transcribed,
          note: "Times are SOURCE-media seconds. Deleted words (D) are cut from the rendered program. Filler words are marked F.",
        }, null, 2),
      }],
    };
  },
);

server.registerTool(
  "read_transcript",
  {
    title: "Read transcript",
    description: `Read word-level transcript lines "id|start-end|text[|D][|F]". Page through with from/to word indexes (0-based). ${PAGE} words per page by default.`,
    inputSchema: {
      from: z.number().int().min(0).default(0).describe("start word index (0-based)"),
      to: z.number().int().min(0).optional().describe("end word index (exclusive)"),
      includeDeleted: z.boolean().default(true).describe("include words already marked deleted"),
    },
  },
  async ({ from, to, includeDeleted }) => {
    const p = load();
    const end = Math.min(to ?? from + PAGE, p.words.length);
    const slice = p.words.slice(from, end).filter((w) => includeDeleted || !w.deleted);
    const words = p.words;
    const lastIdx = words.length - 1;
    return {
      content: [{
        type: "text",
        text: `words ${from}-${end} of ${words.length} (last index ${lastIdx})\n` + slice.map(fmt).join("\n"),
      }],
    };
  },
);

server.registerTool(
  "find_text",
  {
    title: "Find text in transcript",
    description: "Case-insensitive search over the transcript. Returns matching words with ±10 words of context.",
    inputSchema: {
      query: z.string().min(1).describe("text to search for"),
    },
  },
  async ({ query }) => {
    const p = load();
    const q = query.toLowerCase();
    const out = [];
    for (let i = 0; i < p.words.length; i++) {
      if (!p.words[i].text.toLowerCase().includes(q)) continue;
      const from = Math.max(0, i - 10);
      const to = Math.min(p.words.length, i + 11);
      out.push(`— match at word ${i} —\n` + p.words.slice(from, to).map(fmt).join("\n"));
      if (out.length >= 20) break;
    }
    return { content: [{ type: "text", text: out.length ? out.join("\n\n") : `no matches for "${query}"` }] };
  },
);

server.registerTool(
  "delete_words",
  {
    title: "Delete words",
    description: "Mark words as deleted (cut from the rendered video) by id. Use read_transcript/find_text to get ids first.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("word ids, e.g. [\"w12\",\"w13\"]"),
    },
  },
  async ({ ids }) => {
    const p = load();
    const byId = new Map(p.words.map((w) => [w.id, w]));
    let n = 0;
    for (const id of ids) {
      const w = byId.get(id);
      if (w && !w.deleted) {
        w.deleted = true;
        n++;
      }
    }
    save(p);
    return { content: [{ type: "text", text: `deleted ${n} word(s); program now keeps ${p.words.filter((w) => !w.deleted).length} of ${p.words.length} words` }] };
  },
);

server.registerTool(
  "restore_words",
  {
    title: "Restore words",
    description: "Un-delete words by id, putting them back into the program.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("word ids to restore"),
    },
  },
  async ({ ids }) => {
    const p = load();
    const byId = new Map(p.words.map((w) => [w.id, w]));
    let n = 0;
    for (const id of ids) {
      const w = byId.get(id);
      if (w && w.deleted) {
        w.deleted = false;
        n++;
      }
    }
    save(p);
    return { content: [{ type: "text", text: `restored ${n} word(s)` }] };
  },
);

server.registerTool(
  "delete_time_range",
  {
    title: "Cut a time range",
    description: "Delete every word that overlaps a SOURCE time range (seconds). Use for 'cut the part where I ramble about X' after finding the start/end via find_text.",
    inputSchema: {
      start: z.number().min(0).describe("range start, source seconds"),
      end: z.number().min(0).describe("range end, source seconds"),
    },
  },
  async ({ start, end }) => {
    const p = load();
    if (end <= start) return { content: [{ type: "text", text: "end must be > start" }] };
    let n = 0;
    for (const w of p.words) {
      if (w.start < end && w.end > start && !w.deleted) {
        w.deleted = true;
        n++;
      }
    }
    save(p);
    return { content: [{ type: "text", text: `cut ${start.toFixed(1)}s-${end.toFixed(1)}s: deleted ${n} word(s)` }] };
  },
);

server.registerTool(
  "remove_filler_words",
  {
    title: "Remove all filler words",
    description: "Mark every detected filler word (um, uh, you know, basically...) as deleted.",
    inputSchema: {},
  },
  async () => {
    const p = load();
    let n = 0;
    for (const w of p.words) {
      if (w.filler && !w.deleted) {
        w.deleted = true;
        n++;
      }
    }
    save(p);
    return { content: [{ type: "text", text: `deleted ${n} filler word(s)` }] };
  },
);

server.registerTool(
  "remove_silences",
  {
    title: "Tighten pauses",
    description: "Turn on (or off) shortening of long pauses: quiet stretches of the audio (decided by audio level alone; transcribed words do not block a pause), at least minGap seconds long, keeping margin seconds on each side. Pauses are analyzed when the project is transcribed or first opened in the editor.",
    inputSchema: {
      enabled: z.boolean().default(true).describe("true to tighten pauses, false to keep them"),
      minGap: z.number().min(0.3).max(60).default(1.0).describe("only pauses at least this many seconds long"),
      margin: z.number().min(0).max(30).default(0.25).describe("seconds of each pause to keep on each side"),
    },
  },
  async ({ enabled, minGap, margin }) => {
    if (margin * 2 >= minGap) return { content: [{ type: "text", text: "margin must be less than half of minGap" }], isError: true };
    const p = load();
    p.tightenPauses = { enabled, minGap, margin };
    save(p);
    const ready = Array.isArray(p.pauses);
    return { content: [{ type: "text", text: `tighten pauses ${enabled ? "on" : "off"} (pauses over ${minGap}s, keep ${margin}s each side)${ready ? "" : ". Pauses are not analyzed yet: open the project in the editor once."}` }] };
  },
);

server.registerTool(
  "find_retakes",
  {
    title: "Find repeated takes",
    description: "List repeated takes: an earlier attempt at a phrase (bad) followed by the take to keep (good), found by the same local detector the editor highlights (ADR-006). Read-only; delete a bad take's word ids with delete_words only if the user asked for cuts.",
    inputSchema: {},
  },
  async () => {
    let lib;
    try {
      lib = { retakes: await import("../src/lib/retakes.ts"), edl: await import("../src/lib/edl.ts") };
    } catch (e) {
      return { content: [{ type: "text", text: `retake detector unavailable on this Node (${process.version}; needs TypeScript type stripping): ${e.message}` }], isError: true };
    }
    const p = load();
    const found = lib.retakes.findRetakes(p.words, p.pauses, lib.edl.deriveCuts(p));
    if (!found.length) return { content: [{ type: "text", text: "no repeated takes found" }] };
    const line = (r) => `${r.kind} ${r.similarity} | BAD ${r.bad.start.toFixed(2)}s [${r.bad.wordIds[0]}..${r.bad.wordIds[r.bad.wordIds.length - 1]}] "${r.bad.text}" | KEEP ${r.good.start.toFixed(2)}s "${r.good.text}"`;
    return { content: [{ type: "text", text: found.map(line).join("\n") }] };
  },
);

// ── run ─────────────────────────────────────────────────────────────────────
await server.connect(new StdioServerTransport());

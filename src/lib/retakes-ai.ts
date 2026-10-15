import { spawn } from "child_process";
import os from "os";
import path from "path";
import type { AiRetakePair } from "./types";
import type { Segment } from "./retakes";

// ── Repeated takes, AI check (ADR-007) ──────────────────────────────────────
// capcut's AI pass (my-project/capcut/core/ai_detector.py): the same conservative prompt, run
// through headless Claude Code (`claude-safe -p`, the subscription, not a metered API key).
// The model only proposes; the editor shows its pairs beside the local ones and nothing is cut
// without a click.

export const AI_RETAKE_MODEL = "claude-sonnet-5";
export const AI_RETAKE_EFFORT = "medium";
export const AI_MIN_CONFIDENCE = 0.75;
const AI_MAX_SECONDS = 300;

// Verbatim from capcut ai_detector._SYSTEM_PROMPT (its AI_LOOK_AHEAD is 10).
export const AI_RETAKE_SYSTEM_PROMPT = "You analyze video transcripts to detect OBVIOUS bad takes in recorded video. The speaker is recording and when they make a mistake, stutter, or restart a sentence, they pause and re-attempt THE SAME LINE. The LAST attempt is always the keeper \u2014 earlier attempts of THE SAME LINE are bad takes.\n\nBE CONSERVATIVE: Only flag segments that are CLEARLY retakes of each other. When in doubt, do NOT flag. It's better to miss a bad take than to cut good content.\n\nONLY flag these patterns:\n1. EXACT/NEAR REPEATS: Same sentence said multiple times with minor word changes. Example: 'So let me show you' \u2192 'So let me show you the results'\n2. STUTTERS: Speaker stammers or repeats words. Example: 'So basically this is So basically this is considered' \u2014 clear stutter.\n3. INCOMPLETE FRAGMENTS: Short abandoned phrases (1-5 words) immediately followed by a complete sentence starting the same way. Example: 'Here's the here's' \u2192 'Here's the breakdown'\n4. CLEAR RESTARTS: Speaker obviously stops mid-sentence and restarts the SAME sentence. The key word is SAME \u2014 both segments must be attempting to say the same thing.\n5. CLUSTERED REPETITION: When the speaker makes the SAME promise/setup multiple times IN A ROW (within 30-60 seconds), keep only the LAST complete version. Look for clusters like:\n   - 'I'm gonna show you the receipts' \u2192 [gap] \u2192 'I'm gonna show you all the wins' \u2192 [gap] \u2192 'I'm gonna show you the receipts of all the wins' \u2014 first two are bad takes, last is the keeper.\n   - 'I'm gonna explain' said 3 times trying to set up the same point.\n   - 'Stick around' / 'Stay tuned' said multiple times in same intro section.\n   The KEY is they're CLUSTERED (back-to-back attempts) not spread throughout the video.\n   NOTE: 'I'm gonna show you' spread across the video referring to DIFFERENT things is fine.\n6. LOOK AHEAD: Check up to 10 segments ahead for the good version.\n\nCRITICAL - Do NOT flag:\n- The HOOK: the first spoken segment (its index is given in the task) \u2014 must NEVER be cut\n- Segments about DIFFERENT topics (even if they sound similar)\n- Natural flow and continuations \u2014 if segment B continues or expands on segment A, that's normal speech, NOT a bad take\n- Setup sentences followed by explanations \u2014 'Let me show you' followed by showing is NOT a retake\n- Segments that contradict each other \u2014 opposites are NOT retakes\n- Transitions between topics\n- LISTS of different items with similar structure \u2014 'Bulls to win, Cavs to win, Lakers to win' are THREE different picks, NOT retakes. The pattern 'X to win' repeats but X is different each time.\n- Numbers spoken in shorthand \u2014 'two two two' for 222, 'one ten' for 110, etc. are NOT stutters, they are intentional pronunciations of numbers\n- Sports betting content: team names, spreads, odds, point totals \u2014 these often follow patterns but are listing DIFFERENT bets, not retaking the same line\n- Structural repetition SPREAD throughout video: 'I'm gonna show you the receipts' at 1:00, then 'I'm gonna show you the tool' at 5:00, then 'I'm gonna show you the slip' at 8:00 \u2014 these are DIFFERENT things being shown, NOT retakes\n- CTAs (calls-to-action): 'Subscribe', 'check out the link', 'go to the pinned comment' \u2014 these are intentionally repeated throughout and should NOT be flagged\n- Any segment where you're not 80%+ confident it's a retake\n\nASK YOURSELF: Is this segment a failed or incomplete attempt at saying what appears later? Is keeping both segments redundant?\n\nConfidence: 0.90-1.0 for stutters/exact repeats, 0.75-0.90 for restarts/rephrased. Do NOT flag anything below 0.75 confidence.";

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

// The hook (first phrase) is never flagged.
export function aiRetakePrompt(segments: Segment[]): string {
  return [
    "Find OBVIOUS bad takes in this transcript. Only flag clear stutters, restarts, and repeated sentences. Do NOT flag natural speech flow or different topics. Be conservative — when in doubt, don't flag.",
    "The HOOK is segment 0; never flag it.",
    "Format: index | timestamp | text",
    "",
    ...segments.map((s, i) => `${i} | ${clock(s.start)} | ${s.text}`),
    "",
    "Return ONLY a JSON array, no other text, no markdown code fences. Each element:",
    '{"bad_index": N, "good_index": M, "confidence": 0.XX, "reason": "..."}',
  ].join("\n");
}

// Same validation as capcut: indices in range, bad before good, hook protected, one pair per bad,
// a keeper never also a bad take. Plus capcut's own 0.75 floor, enforced here instead of trusted.
export function parseAiRetakes(text: string, segments: Segment[]): AiRetakePair[] {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new Error(`AI check returned non-JSON output: ${body.slice(0, 200)}`); }
  if (!Array.isArray(raw)) return [];
  const pairs: { bad: number; good: number; confidence: number; reason: string }[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const bad = Number(item?.bad_index), good = Number(item?.good_index), confidence = Number(item?.confidence ?? 0.75);
    if (!Number.isInteger(bad) || !Number.isInteger(good) || bad < 0 || good >= segments.length || bad >= good || bad === 0) continue;
    if (!(confidence >= AI_MIN_CONFIDENCE) || pairs.some((p) => p.bad === bad || p.good === bad)) continue;
    pairs.push({ bad, good, confidence, reason: String(item.reason ?? "") });
  }
  return pairs.map((p) => ({ badIds: segments[p.bad].wordIds, goodIds: segments[p.good].wordIds, confidence: p.confidence, reason: p.reason }));
}

// The transcript goes over stdin, never argv (capcut ADR-053: long recordings overflow argv).
export function runAiRetakeCheck(segments: Segment[]): Promise<AiRetakePair[]> {
  const bin = path.join(os.homedir(), "bin", "claude-safe");
  const args = ["--model", AI_RETAKE_MODEL, "--effort", AI_RETAKE_EFFORT, "--safe-mode", "--tools", "", "--no-session-persistence", "--system-prompt", AI_RETAKE_SYSTEM_PROMPT, "-p"];
  // claude-safe's watchdog is off (0): its background `sleep` inherits stdout and held the pipe open
  // for the whole limit, turning a 6 s answer into a 290 s wait. The timer below is the limit.
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: { ...process.env, CLAUDE_SAFE_MAX_SECONDS: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), (AI_MAX_SECONDS + 30) * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not start claude-safe: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`));
      if (!out.trim()) return reject(new Error(`claude -p returned no output: ${err.trim().slice(0, 200)}`));
      try { resolve(parseAiRetakes(out, segments)); } catch (e) { reject(e); }
    });
    child.stdin.end(aiRetakePrompt(segments));
  });
}

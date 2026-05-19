#!/usr/bin/env bun
// slice-guard-focus.ts — agentic per-hunk drive-by detector (G-0005).
//
// Replaces the 2000-modified-line cap. For each diff hunk, ask minimax-m2.7
// whether the hunk advances the stated task. If >K% of hunks are drive-bys,
// fail with a labeled list. The ≤1-top-level-area check stays in the bash
// hook (cheap + load-bearing).
//
// Usage:
//   bun bin/slice-guard-focus.ts \
//     --title "<task title or commit subject>" \
//     [--body "<task body>"] \
//     [--diff-args "--cached"] \
//     [--driveby-pct 25]
//
// Env:
//   MINIMAX_API_KEY   required for real calls; absent → SKIP focus.
//   MINIMAX_BASE_URL  default https://api.minimax.io/anthropic/v1/messages
//   MINIMAX_MODEL     default MiniMax-M2.7
//   SLICE_GUARD_DRIVEBY_PCT  default 25
//
// Output: one JSON line per hunk verdict + SUMMARY block. Exit 0 iff drive-by
// percentage is at or below the cap (or focus was SKIPped).

import { spawnSync } from "node:child_process";

export interface Hunk {
  file: string;
  header: string; // raw @@ line + section context
  body: string; // the +/- lines
}

export interface HunkVerdict {
  file: string;
  header: string;
  verdict: "on-task" | "drive-by" | "unknown";
  reason: string;
}

export interface Analyzer {
  (h: Hunk, ctx: { title: string; body: string }): Promise<HunkVerdict>;
}

export function parseDiff(raw: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = raw.split("\n");
  let file = "";
  let header = "";
  let body: string[] = [];
  const flush = () => {
    if (header && file) {
      hunks.push({ file, header, body: body.join("\n") });
    }
    header = "";
    body = [];
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      // diff --git a/path b/path
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = m?.[2] ?? "";
    } else if (line.startsWith("@@")) {
      flush();
      header = line;
    } else if (header) {
      body.push(line);
    }
  }
  flush();
  return hunks;
}

export function makeMinimaxAnalyzer(opts: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Analyzer {
  const baseUrl = opts.baseUrl ?? "https://api.minimax.io/anthropic/v1/messages";
  const model = opts.model ?? "MiniMax-M2.7";
  const f = opts.fetchImpl ?? fetch;
  return async (hunk, ctx) => {
    const prompt = [
      `Task title: ${ctx.title}`,
      ctx.body ? `Task body: ${ctx.body}` : "",
      ``,
      `Diff hunk in file ${hunk.file}:`,
      `${hunk.header}`,
      `${hunk.body}`,
      ``,
      `Question: does this hunk advance the stated task, or is it an unrelated drive-by edit?`,
      `Reply with strict JSON: {"verdict":"on-task"|"drive-by","reason":"<one short sentence>"}`,
    ]
      .filter(Boolean)
      .join("\n");
    let res: Response;
    try {
      res = await f(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err: any) {
      return {
        file: hunk.file,
        header: hunk.header,
        verdict: "unknown",
        reason: `network error: ${err.message ?? err}`,
      };
    }
    if (!res.ok) {
      return {
        file: hunk.file,
        header: hunk.header,
        verdict: "unknown",
        reason: `http ${res.status}`,
      };
    }
    let json: any;
    try {
      json = await res.json();
    } catch (err: any) {
      return {
        file: hunk.file,
        header: hunk.header,
        verdict: "unknown",
        reason: `bad json: ${err.message ?? err}`,
      };
    }
    const text = extractText(json);
    const parsed = parseVerdictJson(text);
    if (!parsed) {
      return {
        file: hunk.file,
        header: hunk.header,
        verdict: "unknown",
        reason: `unparseable: ${text.slice(0, 80)}`,
      };
    }
    return {
      file: hunk.file,
      header: hunk.header,
      verdict: parsed.verdict,
      reason: parsed.reason,
    };
  };
}

function extractText(json: any): string {
  // Anthropic-compatible: {content:[{type:"text",text:"..."},...]}
  if (Array.isArray(json?.content)) {
    return json.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
  }
  // OpenAI-compatible fallback: {choices:[{message:{content:"..."}}]}
  if (Array.isArray(json?.choices)) {
    return json.choices[0]?.message?.content ?? "";
  }
  return "";
}

function parseVerdictJson(
  text: string,
): { verdict: "on-task" | "drive-by"; reason: string } | null {
  const trimmed = text.trim();
  // Try direct JSON first.
  const tryParse = (s: string) => {
    try {
      const j = JSON.parse(s);
      if (
        j &&
        (j.verdict === "on-task" || j.verdict === "drive-by") &&
        typeof j.reason === "string"
      ) {
        return { verdict: j.verdict, reason: j.reason };
      }
    } catch {
      // ignore
    }
    return null;
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  // Extract first {...} block.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const block = trimmed.slice(start, end + 1);
    const v = tryParse(block);
    if (v) return v;
  }
  return null;
}

export interface ScoreResult {
  total: number;
  driveByCount: number;
  unknownCount: number;
  driveByPct: number;
  verdicts: HunkVerdict[];
}

export async function scoreDiff(
  hunks: Hunk[],
  ctx: { title: string; body: string },
  analyzer: Analyzer,
): Promise<ScoreResult> {
  const verdicts: HunkVerdict[] = [];
  for (const h of hunks) {
    verdicts.push(await analyzer(h, ctx));
  }
  const total = verdicts.length;
  const driveByCount = verdicts.filter((v) => v.verdict === "drive-by").length;
  const unknownCount = verdicts.filter((v) => v.verdict === "unknown").length;
  // Denominator excludes "unknown" so a transient API failure doesn't fail the
  // gate. If ALL verdicts are unknown, pct is 0 (caller treats as SKIP).
  const denom = total - unknownCount;
  const driveByPct = denom > 0 ? (driveByCount / denom) * 100 : 0;
  return { total, driveByCount, unknownCount, driveByPct, verdicts };
}

interface CliArgs {
  title: string;
  body: string;
  diffArgs: string[];
  drivebyPct: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    title: "",
    body: "",
    diffArgs: ["--cached"],
    drivebyPct: Number(process.env.SLICE_GUARD_DRIVEBY_PCT ?? 25),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--title") args.title = argv[++i] ?? "";
    else if (a === "--body") args.body = argv[++i] ?? "";
    else if (a === "--diff-args") args.diffArgs = (argv[++i] ?? "").split(" ").filter(Boolean);
    else if (a === "--driveby-pct") args.drivebyPct = Number(argv[++i] ?? 25);
  }
  return args;
}

function gitDiff(args: string[]): string {
  // -U0 keeps each hunk small (no surrounding context lines) to minimize tokens.
  const res = spawnSync("git", ["diff", "-U0", "--no-color", "--no-renames", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`git diff failed: ${res.stderr}`);
  }
  return res.stdout;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title) {
    console.error("slice-guard-focus: --title required");
    return 2;
  }

  const raw = gitDiff(args.diffArgs);
  const hunks = parseDiff(raw);
  if (hunks.length === 0) {
    console.log(JSON.stringify({ gate: "slice-guard-focus", status: "PASS", detail: "no hunks" }));
    console.log("");
    console.log("=== SUMMARY ===");
    console.log("  PASS:slice-guard-focus");
    console.log("  Overall: PASS");
    return 0;
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    console.log(
      JSON.stringify({
        gate: "slice-guard-focus",
        status: "SKIP",
        detail: "MINIMAX_API_KEY unset; focus analysis skipped",
      }),
    );
    console.log("");
    console.log("=== SUMMARY ===");
    console.log("  SKIP:slice-guard-focus");
    console.log("  Overall: PASS");
    return 0;
  }

  const analyzer = makeMinimaxAnalyzer({
    apiKey,
    baseUrl: process.env.MINIMAX_BASE_URL,
    model: process.env.MINIMAX_MODEL,
  });

  const score = await scoreDiff(hunks, { title: args.title, body: args.body }, analyzer);

  for (const v of score.verdicts) {
    console.log(JSON.stringify(v));
  }

  const allUnknown = score.unknownCount === score.total;
  const pctRounded = Math.round(score.driveByPct * 10) / 10;
  const cap = args.drivebyPct;

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(
    `  hunks=${score.total} drive-by=${score.driveByCount} unknown=${score.unknownCount} pct=${pctRounded}% cap=${cap}%`,
  );

  if (allUnknown) {
    console.log("  Overall: SKIP (all hunks unknown — analyzer unreachable)");
    return 0;
  }
  if (score.driveByPct > cap) {
    console.log("  Drive-by hunks:");
    for (const v of score.verdicts) {
      if (v.verdict === "drive-by") {
        console.log(`    ${v.file}: ${v.header} — ${v.reason}`);
      }
    }
    console.log("  Overall: FAIL");
    return 1;
  }
  console.log("  Overall: PASS");
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

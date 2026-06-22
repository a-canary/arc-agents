#!/usr/bin/env bun
// program-bench — per-commit ProgramBench-LITE harness (G-0006.b proxy).
//
// ProgramBench proper is a cleanroom binary-reconstruction benchmark that scores
// ~0% on every frontier model — no local corpus, no per-commit signal. This is
// the LITE proxy CHOICES.md actually asks for: a handful of small CLI programs
// the agent must reconstruct from a behavioural usage doc (spec.md) and is graded
// against HIDDEN behavioural test cases (cases.jsonl). The solver is the SAME
// model stack the factory's workers run (config.json exec alias) — one agent
// call per task, not the full supervisor daemon.
//
//   bun program-bench/run.ts                 # score HEAD, append results.jsonl, render trend.svg
//   bun program-bench/run.ts --sha <sha>     # label the run with a specific commit
//   bun program-bench/run.ts --alias <a>     # override the solver exec alias
//   bun program-bench/run.ts --dry           # score a stub solver (no LLM) — for the scorer self-check
//   bun program-bench/run.ts --feedback      # also write a feedback row to the ingest pipeline (cron sets this)
//   bun program-bench/run.ts --tasks a,b     # restrict to a subset of corpus task ids
//
// Metrics recorded (G-0006.b): pass_rate, secs/task (cost proxy — $/task needs a
// metered runtime we don't have), slices/task=1 (single-agent), hitl=0.

import { spawnSync } from "node:child_process";
import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveAlias } from "../src/config/load";

const HERE = join(import.meta.dir);
const CORPUS = join(HERE, "corpus");
const RESULTS = join(HERE, "results.jsonl");
const SVG = join(HERE, "trend.svg");
const REPO = join(HERE, "..");

type Case = { argv?: string[]; stdin?: string; out?: string; exit?: number };
type TaskResult = { id: string; pass: number; total: number; rate: number };

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return dflt;
  const a = process.argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Extract the first fenced code block + its language tag from solver output. */
function extractProgram(text: string): { lang: string; code: string } | null {
  const m = text.match(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/);
  if (!m) return null;
  return { lang: (m[1] || "").toLowerCase(), code: m[2]! };
}

function interpreterFor(lang: string): { cmd: string; ext: string } | null {
  if (["py", "python", "python3"].includes(lang)) return { cmd: "python3", ext: "py" };
  if (["js", "javascript", "node", "mjs"].includes(lang)) return { cmd: "node", ext: "js" };
  if (["sh", "bash"].includes(lang)) return { cmd: "bash", ext: "sh" };
  return null;
}

/** Run one behavioural case against a written program file. Pass = stdout matches
 *  (trailing-whitespace tolerant) AND exit code matches (default 0). */
function runCase(interp: string, file: string, c: Case): boolean {
  const r = spawnSync(interp, [file, ...(c.argv ?? [])], {
    input: c.stdin ?? "",
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.error) return false;
  if ((r.status ?? 0) !== (c.exit ?? 0)) return false;
  return (r.stdout ?? "").replace(/\s+$/, "") === (c.out ?? "").replace(/\s+$/, "");
}

/** Ask the solver to reconstruct a CLI from its usage doc. Returns program text. */
function solve(spec: string, aliasCmd: string): string {
  const prompt = [
    "Reconstruct a command-line program from this usage documentation.",
    "Output EXACTLY ONE fenced code block (```python / ```javascript / ```bash) and nothing else.",
    "The program is self-contained, reads argv and stdin, writes stdout, sets exit code.",
    "No external packages beyond the language standard library.",
    "",
    "=== USAGE DOC ===",
    spec,
  ].join("\n");
  // Templates are simple whitespace-separated tokens with one {prompt} slot; no
  // shell-quoted args, so a whitespace split is safe. ponytail: split, not shlex.
  const [pre, post] = aliasCmd.split("{prompt}");
  const argv = [
    ...pre.trim().split(/\s+/).filter(Boolean),
    prompt,
    ...(post ?? "").trim().split(/\s+/).filter(Boolean),
  ];
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 300_000 });
  return (r.stdout ?? "") + "\n" + (r.stderr ?? "");
}

/** Stub solver for --dry: returns a correct python program for the one task the
 *  self-check exercises, garbage otherwise. Proves scoring without an LLM. */
function stubSolve(taskId: string): string {
  if (taskId === "rot13") {
    return "```python\nimport sys, codecs\nsys.stdout.write(codecs.encode(sys.stdin.read(), 'rot13'))\n```";
  }
  return "```python\nimport sys\nprint('WRONG')\n```";
}

function scoreTask(id: string, aliasCmd: string, dry: boolean): TaskResult {
  const dir = join(CORPUS, id);
  const spec = readFileSync(join(dir, "spec.md"), "utf8");
  const cases: Case[] = readFileSync(join(dir, "cases.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  const raw = dry ? stubSolve(id) : solve(spec, aliasCmd);
  const prog = extractProgram(raw);
  const interp = prog && interpreterFor(prog.lang);
  if (!prog || !interp) return { id, pass: 0, total: cases.length, rate: 0 };

  const work = mkdtempSync(join(tmpdir(), "pb-"));
  const file = join(work, `prog.${interp.ext}`);
  writeFileSync(file, prog.code);
  let pass = 0;
  for (const c of cases) if (runCase(interp.cmd, file, c)) pass++;
  return { id, pass, total: cases.length, rate: cases.length ? pass / cases.length : 0 };
}

function shortSha(sha?: string): string {
  if (sha) return sha.slice(0, 8);
  const r = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" });
  return (r.stdout ?? "unknown").trim().slice(0, 8);
}

// ── SVG trend (pure string, no deps) ────────────────────────────────────────
type Row = { sha: string; ts: string; rate: number; fully: number; n_tasks: number };
function renderSvg(rows: Row[]): string {
  const W = 720, H = 240, P = 40;
  const pts = rows.slice(-30);
  const x = (i: number) => P + (pts.length <= 1 ? 0 : i * (W - 2 * P) / (pts.length - 1));
  const y = (r: number) => H - P - r * (H - 2 * P);
  const line = pts.map((r, i) => `${x(i).toFixed(1)},${y(r.rate).toFixed(1)}`).join(" ");
  const dots = pts.map((r, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(r.rate).toFixed(1)}" r="3" fill="#2563eb"><title>${r.sha} ${(r.rate * 100).toFixed(0)}%</title></circle>`,
  ).join("");
  const latest = pts.at(-1);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) =>
    `<line x1="${P}" y1="${y(g)}" x2="${W - P}" y2="${y(g)}" stroke="#eee"/>` +
    `<text x="4" y="${(y(g) + 4).toFixed(1)}" font-size="10" fill="#888">${g * 100}%</text>`,
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui,sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${P}" y="20" font-size="13" fill="#111">ProgramBench-lite pass-rate / commit ${latest ? `— latest ${(latest.rate * 100).toFixed(0)}% (${latest.sha})` : ""}</text>
${grid}
<polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2"/>
${dots}
</svg>`;
}

// ── feedback writeback (ingest pipeline) ─────────────────────────────────────
// One ledger feedback row per run, naming the tasks still below 100% as the
// improvement targets. feedback-aggregate.ts later turns these into a Proposal.
// Gated behind --feedback (cron sets it) and the post-2026-06-22 cutoff.
function writeFeedback(sha: string, tasks: TaskResult[], prevRate: number | null, rate: number) {
  const weak = tasks.filter((t) => t.rate < 1).sort((a, b) => a.rate - b.rate);
  if (!weak.length && prevRate !== null && rate >= prevRate) return; // nothing actionable
  const delta = prevRate === null ? "first run" : `${rate >= prevRate ? "+" : ""}${((rate - prevRate) * 100).toFixed(0)}pp vs prev`;
  const body = [
    `ProgramBench-lite @ ${sha}: mean pass-rate ${(rate * 100).toFixed(0)}% (${delta}).`,
    weak.length ? `Weakest tasks (improvement targets): ${weak.map((t) => `${t.id} ${(t.rate * 100).toFixed(0)}%`).join(", ")}.` : "All tasks fully resolved.",
    "Source: program-bench/run.ts. Use to guide agent-stack / profile / prompt improvements.",
  ].join(" ");
  const r = spawnSync("bun", [
    join(REPO, "bin/ledger.ts"), "feedback",
    "--project", "arc-agents", "--source", "program-bench", "--body", body,
  ], { encoding: "utf8" });
  if (r.status === 0) console.log("feedback: logged");
  else console.error("feedback: failed:", (r.stderr ?? "").trim());
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const dry = has("dry");
  const sha = shortSha(arg("sha"));
  const only = arg("tasks")?.split(",").map((s) => s.trim()).filter(Boolean);
  const cfg = loadConfig(REPO);
  const aliasName = arg("alias") ?? cfg.fast_alias ?? cfg.default_alias;
  const aliasCmd = resolveAlias(aliasName, cfg);
  // STRICT: the benchmark runs on the MiniMax subscription ONLY. Anthropic/claude
  // is reserved for development and must never be billed by the harness — a config
  // drift that points the alias at `claude` would silently burn the dev sub.
  if (!dry && (/\bclaude\b/.test(aliasCmd) || !/--provider\s+minimax/.test(aliasCmd))) {
    console.error(
      `program-bench: alias "${aliasName}" -> "${aliasCmd}" is not a MiniMax provider command.\n` +
      `This harness is MiniMax-only (claude is reserved for dev). Point --alias / config at a \`pi --provider minimax\` alias.`,
    );
    process.exit(2);
  }

  let ids = readdirSync(CORPUS).filter((d) => existsSync(join(CORPUS, d, "spec.md"))).sort();
  if (only) ids = ids.filter((id) => only.includes(id));
  if (!ids.length) { console.error("no corpus tasks"); process.exit(1); }

  console.log(`program-bench: ${ids.length} tasks @ ${sha} via ${dry ? "STUB" : aliasName}`);
  const t0 = Date.now();
  const tasks = ids.map((id) => {
    const r = scoreTask(id, aliasCmd, dry);
    console.log(`  ${r.id}: ${r.pass}/${r.total} (${(r.rate * 100).toFixed(0)}%)`);
    return r;
  });
  const wall = (Date.now() - t0) / 1000;

  const rate = tasks.reduce((s, t) => s + t.rate, 0) / tasks.length;
  const fully = tasks.filter((t) => t.rate === 1).length;
  const row = {
    sha, ts: new Date().toISOString(), rate, fully, n_tasks: tasks.length,
    n_cases: tasks.reduce((s, t) => s + t.total, 0),
    secs_per_task: +(wall / tasks.length).toFixed(1), // cost proxy
    slices_per_task: 1, hitl: 0, alias: dry ? "stub" : aliasName,
    tasks: Object.fromEntries(tasks.map((t) => [t.id, +t.rate.toFixed(3)])),
  };
  console.log(`mean ${(rate * 100).toFixed(0)}% | fully ${fully}/${tasks.length} | ${wall.toFixed(0)}s`);

  if (dry) { console.log("(dry: not persisting)"); return; }

  const prev: Row[] = existsSync(RESULTS)
    ? readFileSync(RESULTS, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];
  const prevRate = prev.length ? prev.at(-1)!.rate : null;
  writeFileSync(RESULTS, [...prev.map((r) => JSON.stringify(r)), JSON.stringify(row)].join("\n") + "\n");
  writeFileSync(SVG, renderSvg([...prev, row]));
  console.log(`wrote ${RESULTS} + ${SVG}`);

  if (has("feedback") && row.ts >= "2026-06-22") writeFeedback(sha, tasks, prevRate, rate);
}

main();

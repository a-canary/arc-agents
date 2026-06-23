#!/usr/bin/env bun
// plan.ts — front-half emitter of the self-guided pipeline (ADR-0010).
//
//   plan.ts --title T [--body MD] [--project P] --tracer "slice 1" [--tracer ...] [--thread TH]
//
// Mints a PRD (kind=prd) parked at the human approval gate (state=review) plus
// one tracer-bullet task per --tracer, each blocked on the PRD. Approving the
// PRD at /approvals flips it to merged; the canonical unblock_dependents trigger
// then releases the tracers to 'ready' for the bg-worker pool. This emitter only
// PRODUCES proposals — it never spawns implementation workers, merges, or deploys.
//
// Designed to be launched as a detached subprocess by arc-webui /chat, never run
// inside the Hono web process. All writes route through the canonical ledger CLI
// (validation + id-mint + events), not raw INSERTs.

import { spawnSync } from "node:child_process";
import { LEDGER_BIN, dbFlag } from "../src/ledger/cli-invoke";

const DB_FLAG = dbFlag();
const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
}

function getAll(name: string): string[] {
  const vals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) { const v = args[i + 1]; if (v) vals.push(v); }
    else if (a.startsWith(`--${name}=`)) vals.push(a.slice(a.indexOf("=") + 1));
  }
  return vals;
}

function die(msg: string, code = 1): never {
  process.stderr.write(`plan: ${msg}\n`);
  process.exit(code);
}

function ledger(verb: string, rest: string[]): Record<string, unknown> {
  const r = spawnSync(process.execPath, [LEDGER_BIN, verb, ...rest, ...DB_FLAG], { encoding: "utf8" });
  if (r.status !== 0) die(`ledger ${verb} failed: ${r.stderr || r.stdout}`);
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

const project = getFlag("project") ?? "arc-webui";
const title = getFlag("title");
const body = getFlag("body") ?? "";
const thread = getFlag("thread");
const tracers = getAll("tracer");

if (!title) die("usage: plan.ts --title T [--body MD] [--project P] --tracer S [--tracer ...]", 2);
if (tracers.length === 0) die("at least one --tracer is required", 2);

// 1. mint the PRD, then park it at the human approval gate.
const prdId = ledger("create", [
  "--kind", "prd", "--type", "mvp", "--project", project,
  "--title", title, "--body", body, "--agent", "director", "--tier", "mvp",
  "--source-module", "plan",
  ...(thread ? ["--thread", thread] : []),
]).id as string;
ledger("update", [prdId, "--state", "review"]);

// 2. one tracer-bullet task per slice, each blocked on the PRD so it stays out
//    of the worker pool until the human approves at the gate.
const tracerIds = tracers.map((t) =>
  ledger("create", [
    "--kind", "task", "--type", "mvp", "--project", project,
    "--title", t, "--blocked-by", JSON.stringify([prdId]),
    "--agent", "developer", "--tier", "mvp", "--pool", "build",
    "--source-module", "plan",
  ]).id as string,
);

process.stdout.write(JSON.stringify({ prdId, tracerIds }) + "\n");

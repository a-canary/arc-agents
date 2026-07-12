#!/usr/bin/env bun
// plan.ts — front-half emitter of the self-guided pipeline (ADR-0010).
//
//   plan.ts --title T [--body MD] [--project P] --tracer "slice 1" [--tracer ...]
//          [--relationship '{"other_prd_id":"prd-x","kind":"dependency"}'] [--thread TH]
//
// Mints a PRD (kind=prd) parked at the human approval gate (state=review) plus
// one tracer-bullet task per --tracer, each blocked on the PRD. Approving the
// PRD at /approvals flips it to merged; the canonical unblock_dependents trigger
// then releases the tracers to 'ready' for the bg-worker pool. This emitter only
// PRODUCES proposals — it never spawns implementation workers, merges, or deploys.
//
// Designed to be launched as a detached subprocess by arc-webui /chat, never run
// inside the Hono web process. All writes route through the canonical ledger CLI
// (validation + id-mint + events), not raw INSERTs. Pairwise relationships
// (parent PRD user-webui-chat-planner-should-be-tasked-isz6, migration 028) are
// persisted transactionally in the same DB connection — one INSERT per pair,
// COMMIT atomically.

import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { LEDGER_BIN, dbFlag } from "../src/ledger/cli-invoke";
import { isParkedProject } from "../src/project-repo-map";

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

// Pairwise PRD relationship kinds (migration 028). Closed vocabulary; the SQL
// CHECK constraint enforces it — we re-validate here so a malformed --relationship
// payload fails fast with a clear message instead of a raw SQLITE_CONSTRAINT.
const RELATIONSHIP_KINDS = new Set(["orthogonal", "replace", "dependency", "fork"]);
type Relationship = { other_prd_id: string; kind: string };

function parseRelationships(raw: readonly string[]): Relationship[] {
  const out: Relationship[] = [];
  for (const s of raw) {
    let r: unknown;
    try { r = JSON.parse(s); } catch { die(`--relationship not JSON: ${s}`, 2); }
    if (!r || typeof r !== "object") die(`--relationship not an object: ${s}`, 2);
    const o = r as { other_prd_id?: unknown; kind?: unknown };
    if (typeof o.other_prd_id !== "string" || !o.other_prd_id.trim()) {
      die(`--relationship missing string other_prd_id: ${s}`, 2);
    }
    if (typeof o.kind !== "string" || !RELATIONSHIP_KINDS.has(o.kind)) {
      die(`--relationship.kind must be one of [${[...RELATIONSHIP_KINDS].join(", ")}]: ${s}`, 2);
    }
    out.push({ other_prd_id: o.other_prd_id.trim(), kind: o.kind });
  }
  return out;
}

const project = getFlag("project") ?? "arc-webui";
const title = getFlag("title");
const body = getFlag("body") ?? "";
const thread = getFlag("thread");
const tracers = getAll("tracer");
const relationships = parseRelationships(getAll("relationship"));

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
// Parked projects (GPU/vast spend, e.g. starlight-slm) never get an auto-claimable
// task: force hitl=1 so src/ledger/claim.ts's `WHERE hitl=0` filter keeps it out of
// the AFK worker pool until a human clears it — the spend gate.
const parked = isParkedProject(project);
const tracerIds = tracers.map((t) => {
  const id = ledger("create", [
    "--kind", "task", "--type", "mvp", "--project", project,
    "--title", t, "--blocked-by", JSON.stringify([prdId]),
    "--agent", "developer", "--tier", "mvp", "--pool", "build",
    "--source-module", "plan",
  ]).id as string;
  if (parked) ledger("update", [id, "--hitl", "1"]);
  return id;
});

// 3. pairwise relationships — insert transactionally. We open the same DB the
//    ledger CLI wrote to (ARC_LEDGER_DB env override, or ~/vault/ledger.db)
//    and run a single transaction. A bad kind or a missing target PRD surfaces
//    here as a SQLITE_CONSTRAINT (CHECK / FK), and we die loudly instead of
//    leaving a partial PRD-without-relationships behind.
if (relationships.length > 0) {
  const dbPath = process.env.ARC_LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`;
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      const stmt = db.prepare(
        `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, ?)`,
      );
      for (const r of relationships) {
        stmt.run(prdId, r.other_prd_id, r.kind);
      }
    })();
  } catch (e) {
    db.close();
    die(`prd_relationships insert failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  db.close();
}

process.stdout.write(JSON.stringify({ prdId, tracerIds, relationships }) + "\n");
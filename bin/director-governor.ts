#!/usr/bin/env bun
// Standalone token/activity governor. Bound into a caller's loop via its own
// AGENTS.md (e.g. arc-skills' /director `budget` binding) — this file knows
// nothing about "Director" or any owning agent; it is a pure guard any
// delegator can shell out to before spawning new work against a repo.
// A PAUSE flag stops spawning NEW work; a KILL flag stops the caller entirely;
// a per-repo weekly token budget bounds spend without an operator watching.
// Modeled on bin/opus-burn-check.ts: a PURE decision function plus a thin
// never-fatal CLI shell that always `process.exit(0)` — a governor must not
// crash the thing it guards.
//
// KNOWN GAP: codeburn exposes only a HOST-WIDE weekly token sum — there is no
// per-repo attribution today. So `repoBudget` below is a real per-repo
// threshold, but `tokensThisWeek` is still the host-wide spend compared
// against it. Two repos with different budgets will trip at different
// thresholds, but neither sees its own isolated spend yet. Fix requires
// tagging spend by repo/session at the source — tracked as a follow-up, not
// solved here.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Shape types ──────────────────────────────────────────────────────────────

export interface GovernorState {
  killed: boolean; // kill flag present
  paused: boolean; // pause flag present
  tokensThisWeek: number; // host-wide spend in the current week (see KNOWN GAP above)
  repoBudget: number; // this repo's weekly cap, supplied by the caller's AGENTS.md binding
}

export type RestrictTo = "critical-only" | null;

export interface GovernorVerdict {
  allowCaller: boolean; // false ⇒ caller must not run at all
  allowSpawn: boolean; // false ⇒ must not spawn ordinary NEW work
  restrictTo: RestrictTo; // "critical-only" ⇒ may still spawn production-stability/security work
  reason: string; // terse deterministic reason
}

// ── Pure decision function (golden-tested) ───────────────────────────────────
// Precedence, most severe first:
//   1. killed      ⇒ caller must not run at all.
//   2. paused      ⇒ alive, but no new work (beats budget).
//   3. over budget ⇒ alive, ordinary work blocked, but critical-failure/security
//                    work may still proceed (>= is the gate; budget<=0 = no cap).
//   4. ok          ⇒ run + spawn freely.
// Pure: no I/O, no globals, no Date/Math/console.
export function governor(state: GovernorState): GovernorVerdict {
  if (state.killed) {
    return { allowCaller: false, allowSpawn: false, restrictTo: null, reason: "killed" };
  }
  if (state.paused) {
    return { allowCaller: true, allowSpawn: false, restrictTo: null, reason: "paused" };
  }
  const hasBudget = state.repoBudget > 0;
  if (hasBudget && state.tokensThisWeek >= state.repoBudget) {
    return {
      allowCaller: true,
      allowSpawn: false,
      restrictTo: "critical-only",
      reason: `weekly token budget exhausted (${state.tokensThisWeek}/${state.repoBudget}) — critical-failure/security work only`,
    };
  }
  return { allowCaller: true, allowSpawn: true, restrictTo: null, reason: "ok" };
}

// ── Flag resolution (injectable, so governor() stays pure) ────────────────────

export interface ResolveOpts {
  sentinelDir: string; // caller-supplied dir for KILL/PAUSE files (e.g. <parent-repo>/.arc/director/)
  repoBudget: number;
  tokensThisWeek: number;
}

// ponytail: sentinel-file flags are the simplest reactive control — `existsSync`
// of a file under a caller-supplied directory. Upgrade to a ledger row if you
// need history (who set it, when, why).
export function resolveState(opts: ResolveOpts): GovernorState {
  return {
    killed: existsSync(join(opts.sentinelDir, "KILL")),
    paused: existsSync(join(opts.sentinelDir, "PAUSE")),
    tokensThisWeek: opts.tokensThisWeek,
    repoBudget: opts.repoBudget,
  };
}

// Sensible default per-repo weekly cap (tokens) when --weekly-budget absent.
export const DEFAULT_WEEKLY_BUDGET = 50_000_000;

// ── codeburn weekly token sum (best-effort; never fatal) ──────────────────────

interface ModelRow {
  "Input Tokens"?: number;
  "Output Tokens"?: number;
  "Cache Read Tokens"?: number;
  "Cache Write Tokens"?: number;
}
interface PeriodEntry {
  label?: string;
  Period?: string;
  models?: ModelRow[];
}
interface CodeburnExport {
  periods?: PeriodEntry[];
}

// ponytail: per-Director attribution is hard — tokens aren't tagged by director.
// This uses the HOST-WIDE weekly token sum as the bound. Upgrade to per-Director
// attribution if/when tokens carry a director tag.
export function computeWeeklyTokens(exportJson: unknown): number {
  const safe = exportJson as CodeburnExport | null | undefined;
  if (!safe || !Array.isArray(safe.periods)) return 0;
  const week = safe.periods.find((p) => (p.label ?? p.Period) === "7 Days");
  if (!week || !Array.isArray(week.models)) return 0;
  return week.models.reduce(
    (acc, r) =>
      acc +
      (r["Input Tokens"] ?? 0) +
      (r["Output Tokens"] ?? 0) +
      (r["Cache Read Tokens"] ?? 0) +
      (r["Cache Write Tokens"] ?? 0),
    0,
  );
}

// Shell out to codeburn for the weekly token sum. Returns 0 on any failure —
// codeburn-unavailable must never block the Director.
function readWeeklyTokens(): number {
  const tmpDir = process.env.CLAUDE_JOB_DIR ?? mkdtempSync(join(tmpdir(), "director-governor-"));
  const outFile = join(tmpDir, `codeburn-export-${Date.now()}.json`);
  const codeburnBin = "/usr/local/lib/node_modules/node/bin/codeburn";

  let exportText: string | null = null;
  for (const bin of ["codeburn", codeburnBin]) {
    const result = spawnSync(
      bin,
      ["export", "--format", "json", "--output", outFile],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      try {
        exportText = readFileSync(outFile, "utf8");
      } catch {
        // File not written despite exit 0 — treat as no data.
      }
      break;
    }
  }
  try {
    unlinkSync(outFile);
  } catch {
    // Best-effort cleanup.
  }

  if (!exportText || exportText.trim() === "") return 0;
  try {
    return computeWeeklyTokens(JSON.parse(exportText));
  } catch {
    return 0;
  }
}

// ── Flag parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { sentinelDir: string; weeklyBudget: number } {
  let sentinelDir = "";
  let weeklyBudget = DEFAULT_WEEKLY_BUDGET;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sentinel-dir") sentinelDir = argv[++i] ?? "";
    else if (argv[i] === "--weekly-budget") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) weeklyBudget = n;
    }
  }
  return { sentinelDir, weeklyBudget };
}

// ── Main (thin, never-fatal) ──────────────────────────────────────────────────

if (import.meta.main) {
  try {
    const { sentinelDir, weeklyBudget } = parseArgs(process.argv.slice(2));
    if (!sentinelDir) {
      console.log(
        "[governor] usage: director-governor --sentinel-dir <path> [--weekly-budget N]",
      );
      process.exit(0);
    }
    const state = resolveState({
      sentinelDir,
      repoBudget: weeklyBudget,
      tokensThisWeek: readWeeklyTokens(),
    });
    const verdict = governor(state);
    console.log(
      `[governor] ${sentinelDir}: caller=${verdict.allowCaller} spawn=${verdict.allowSpawn}` +
        `${verdict.restrictTo ? ` restrict=${verdict.restrictTo}` : ""} (${verdict.reason})`,
    );
  } catch {
    // A governor must never crash the thing it guards.
  }
  process.exit(0);
}

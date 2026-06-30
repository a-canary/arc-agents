#!/usr/bin/env bun
// Director governor. A reactive + budget guard for a Director: a per-Director
// PAUSE flag stops spawning NEW work; a KILL flag stops the Director entirely;
// a token-per-week budget bounds planning+worker spend without an operator
// watching. Modeled on bin/opus-burn-check.ts: a PURE decision function plus a
// thin never-fatal CLI shell that always `process.exit(0)` — a governor must
// not crash the thing it guards.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  mkdtempSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ── Shape types ──────────────────────────────────────────────────────────────

export interface GovernorState {
  killed: boolean; // kill flag present
  paused: boolean; // pause flag present
  tokensThisWeek: number; // spend in the current week
  weeklyBudget: number; // per-Director cap
}

export interface GovernorVerdict {
  allowDirector: boolean; // false ⇒ Director must not run at all
  allowSpawn: boolean; // false ⇒ must not spawn NEW work
  reason: string; // terse deterministic reason
}

// ── Pure decision function (golden-tested) ───────────────────────────────────
// Precedence, most severe first:
//   1. killed      ⇒ Director must not run at all.
//   2. paused      ⇒ alive, but no new work (beats budget).
//   3. over budget ⇒ alive, but no new work (>= is the gate; budget<=0 = no cap).
//   4. ok          ⇒ run + spawn freely.
// Pure: no I/O, no globals, no Date/Math/console.
export function governor(state: GovernorState): GovernorVerdict {
  if (state.killed) {
    return { allowDirector: false, allowSpawn: false, reason: "killed" };
  }
  if (state.paused) {
    return { allowDirector: true, allowSpawn: false, reason: "paused" };
  }
  const hasBudget = state.weeklyBudget > 0;
  if (hasBudget && state.tokensThisWeek >= state.weeklyBudget) {
    return {
      allowDirector: true,
      allowSpawn: false,
      reason: `weekly token budget exhausted (${state.tokensThisWeek}/${state.weeklyBudget})`,
    };
  }
  return { allowDirector: true, allowSpawn: true, reason: "ok" };
}

// ── Flag resolution (injectable, so governor() stays pure) ────────────────────

export interface ResolveOpts {
  home: string;
  group: string;
  weeklyBudget: number;
  tokensThisWeek: number;
}

// ponytail: sentinel-file flags are the simplest reactive control — `existsSync`
// of a file under the director's vault dir. Upgrade to a ledger row if you need
// history (who set it, when, why).
export function resolveState(opts: ResolveOpts): GovernorState {
  const dir = join(opts.home, "vault", "agents", "directors", opts.group);
  return {
    killed: existsSync(join(dir, "KILL")),
    paused: existsSync(join(dir, "PAUSE")),
    tokensThisWeek: opts.tokensThisWeek,
    weeklyBudget: opts.weeklyBudget,
  };
}

// Sensible default per-Director weekly cap (tokens) when --weekly-budget absent.
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

function parseArgs(argv: string[]): { group: string; weeklyBudget: number } {
  let group = "";
  let weeklyBudget = DEFAULT_WEEKLY_BUDGET;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--group") group = argv[++i] ?? "";
    else if (argv[i] === "--weekly-budget") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) weeklyBudget = n;
    }
  }
  return { group, weeklyBudget };
}

// ── Main (thin, never-fatal) ──────────────────────────────────────────────────

if (import.meta.main) {
  try {
    const { group, weeklyBudget } = parseArgs(process.argv.slice(2));
    if (!group) {
      console.log("[governor] usage: director-governor --group <G> [--weekly-budget N]");
      process.exit(0);
    }
    const state = resolveState({
      home: process.env.HOME ?? homedir(),
      group,
      weeklyBudget,
      tokensThisWeek: readWeeklyTokens(),
    });
    const verdict = governor(state);
    console.log(
      `[governor] ${group}: director=${verdict.allowDirector} spawn=${verdict.allowSpawn} (${verdict.reason})`,
    );
  } catch {
    // A governor must never crash the thing it guards.
  }
  process.exit(0);
}

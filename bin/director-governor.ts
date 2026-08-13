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
// Per-repo attribution: each sentinel dir houses a WEEKLY_TOKENS file (or
// WEEKLY_TOKENS_<director-name> file when --director-name is passed) that
// the caller (e.g. a Director binding) maintains with that repo's cumulative
// weekly spend. The caller increments the tally after each session based on
// its own token accounting — this file knows nothing about how tokens are
// counted, only how to read the tally. Per-Director naming enables multiple
// callers sharing a sentinel dir to track spend independently.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Shape types ──────────────────────────────────────────────────────────────

export interface GovernorState {
  killed: boolean; // kill flag present
  paused: boolean; // pause flag present
  tokensThisWeek: number; // per-repo weekly spend (read from WEEKLY_TOKENS under sentinelDir)
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
  directorName?: string; // optional director name for per-Director token attribution
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

// ── Per-repo / per-Director weekly token tally (file-based; never fatal) ────
// The caller maintains a WEEKLY_TOKENS file (or WEEKLY_TOKENS_<director-name>
// when --director-name is passed) under the sentinel dir with the cumulative
// token spend for that repo / director this week. This replaces the old
// host-wide codeburn export — each repo now tracks its own spend independently,
// and optionally per-Director for attribution within a shared sentinel dir.
//
// The caller can record spend via `writeWeeklyTokens()` / `writeWeeklyTokensForDirector()`
// (or `--record-spend N` on the CLI) after each session. The governor reads
// the tally via `readWeeklyTokens()` / `readWeeklyTokensForDirector()` when
// checking budget before spawning new work.

// Returns the token-filename (base name) for a given sentinel dir, optionally
// scoped to a director name. Internal helper, exported for testing.
export function weeklyTokensFileName(directorName?: string): string {
  return directorName ? `WEEKLY_TOKENS_${directorName}` : "WEEKLY_TOKENS";
}

export function readWeeklyTokens(sentinelDir: string): number {
  const tokenFile = join(sentinelDir, "WEEKLY_TOKENS");
  try {
    const content = readFileSync(tokenFile, "utf8").trim();
    if (content === "") return 0;
    const n = Number(content);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    // File absent or unreadable — no spend recorded yet. Never fatal.
    return 0;
  }
}

// Record additional token spend to the per-repo WEEKLY_TOKENS tally.
// Reads the current value (0 if absent), adds `tokens`, and writes back.
// Returns the new cumulative total, or NaN on failure (caller should treat
// as non-fatal).
export function writeWeeklyTokens(sentinelDir: string, tokens: number): number {
  if (!Number.isFinite(tokens) || tokens < 0) return NaN;
  const current = readWeeklyTokens(sentinelDir);
  const next = current + Math.floor(tokens);
  try {
    writeFileSync(join(sentinelDir, "WEEKLY_TOKENS"), String(next), "utf8");
    return next;
  } catch {
    return NaN;
  }
}

// ── Per-Director token tracking ──────────────────────────────────────────────
// ponytail: per-Director attribution via WEEKLY_TOKENS_<name> files. Each
// director caller supplies --director-name <name> and gets an independent
// token tally within the shared sentinel dir. The governor reads THAT tally
// when checking budget, enabling per-Director accounting within a repo.

// Read a per-Director token tally. Returns 0 if file absent or unreadable.
export function readWeeklyTokensForDirector(sentinelDir: string, directorName: string): number {
  if (!directorName) return readWeeklyTokens(sentinelDir);
  const tokenFile = join(sentinelDir, weeklyTokensFileName(directorName));
  try {
    const content = readFileSync(tokenFile, "utf8").trim();
    if (content === "") return 0;
    const n = Number(content);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

// Record additional token spend to a per-Director WEEKLY_TOKENS_<name> tally.
// Returns the new cumulative total, or NaN on failure.
export function writeWeeklyTokensForDirector(sentinelDir: string, directorName: string, tokens: number): number {
  if (!directorName) return writeWeeklyTokens(sentinelDir, tokens);
  if (!Number.isFinite(tokens) || tokens < 0) return NaN;
  const current = readWeeklyTokensForDirector(sentinelDir, directorName);
  const next = current + Math.floor(tokens);
  try {
    writeFileSync(join(sentinelDir, weeklyTokensFileName(directorName)), String(next), "utf8");
    return next;
  } catch {
    return NaN;
  }
}

// ── Flag parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { sentinelDir: string; weeklyBudget: number; recordSpend: number; directorName: string } {
  let sentinelDir = "";
  let weeklyBudget = DEFAULT_WEEKLY_BUDGET;
  let recordSpend = -1;
  let directorName = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sentinel-dir") sentinelDir = argv[++i] ?? "";
    else if (argv[i] === "--weekly-budget") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) weeklyBudget = n;
    } else if (argv[i] === "--record-spend") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) recordSpend = n;
    } else if (argv[i] === "--director-name") {
      directorName = argv[++i] ?? "";
    }
  }
  return { sentinelDir, weeklyBudget, recordSpend, directorName };
}

// ── Main (thin, never-fatal) ──────────────────────────────────────────────────

if (import.meta.main) {
  try {
    const { sentinelDir, weeklyBudget, recordSpend, directorName } = parseArgs(process.argv.slice(2));
    if (!sentinelDir) {
      console.log(
        "[governor] usage: director-governor --sentinel-dir <path> [--weekly-budget N] [--record-spend N] [--director-name <name>]",
      );
      process.exit(0);
    }
    // Record-only mode: write spend and exit without checking budget.
    if (recordSpend >= 0) {
      const tokenFile = weeklyTokensFileName(directorName || undefined);
      if (directorName) {
        const total = writeWeeklyTokensForDirector(sentinelDir, directorName, recordSpend);
        if (Number.isFinite(total)) {
          console.log(`[governor] recorded ${recordSpend} tokens to ${sentinelDir}/${tokenFile} (cumulative ${total})`);
        }
      } else {
        const total = writeWeeklyTokens(sentinelDir, recordSpend);
        if (Number.isFinite(total)) {
          console.log(`[governor] recorded ${recordSpend} tokens to ${sentinelDir}/${tokenFile} (cumulative ${total})`);
        }
      }
      process.exit(0);
    }
    const tokensThisWeek = directorName
      ? readWeeklyTokensForDirector(sentinelDir, directorName)
      : readWeeklyTokens(sentinelDir);
    const state = resolveState({
      sentinelDir,
      repoBudget: weeklyBudget,
      tokensThisWeek,
      directorName: directorName || undefined,
    });
    const verdict = governor(state);
    const tag = directorName ? `${sentinelDir} (director=${directorName})` : sentinelDir;
    console.log(
      `[governor] ${tag}: caller=${verdict.allowCaller} spawn=${verdict.allowSpawn}` +
        `${verdict.restrictTo ? ` restrict=${verdict.restrictTo}` : ""} (${verdict.reason})`,
    );
  } catch {
    // A governor must never crash the thing it guards.
  }
  process.exit(0);
}

#!/usr/bin/env bun
// Opus burn-rate monitor. Shells out to `codeburn export` and warns when
// Opus exceeds 50% of trailing-window (Today calendar-day) tokens.
// "Today" is used as the trailing-window proxy — codeburn exposes no
// rolling-24h window; "Today" calendar-day is the closest cheap signal.
// This is a WARNING ONLY — it never throttles or blocks workers.
// TODO(PR-3): route to HITL/notify surface

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Shape types ──────────────────────────────────────────────────────────────

interface ModelRow {
  Period: string;
  Model: string;
  "Cost (USD)": number;
  "Share (%)": number;
  "API Calls": number;
  "Input Tokens": number;
  "Output Tokens": number;
  "Cache Read Tokens": number;
  "Cache Write Tokens": number;
}

interface PeriodEntry {
  label?: string;
  Period?: string;
  models?: ModelRow[];
}

interface CodeburnExport {
  periods?: PeriodEntry[];
}

export interface BurnResult {
  opusShare: number;
  totalCostUsd: number;
  warn: boolean;
}

// ── Pure computation (unit-testable without shelling out) ────────────────────

export function computeOpusBurn(exportJson: unknown): BurnResult {
  const safe = exportJson as CodeburnExport | null | undefined;
  if (!safe || !Array.isArray(safe.periods)) {
    return { opusShare: 0, totalCostUsd: 0, warn: false };
  }

  const today = safe.periods.find(
    (p) => (p.label ?? p.Period) === "Today",
  );
  if (!today || !Array.isArray(today.models) || today.models.length === 0) {
    return { opusShare: 0, totalCostUsd: 0, warn: false };
  }

  const models = today.models;

  function tokenSum(rows: ModelRow[]): number {
    return rows.reduce(
      (acc, r) =>
        acc +
        (r["Input Tokens"] ?? 0) +
        (r["Output Tokens"] ?? 0) +
        (r["Cache Read Tokens"] ?? 0) +
        (r["Cache Write Tokens"] ?? 0),
      0,
    );
  }

  const allTokens = tokenSum(models);
  const opusRows = models.filter((r) => /opus/i.test(r.Model ?? ""));
  const opusTokens = tokenSum(opusRows);

  const opusShare = allTokens === 0 ? 0 : opusTokens / allTokens;
  const totalCostUsd = models.reduce((acc, r) => acc + (r["Cost (USD)"] ?? 0), 0);

  return {
    opusShare,
    totalCostUsd,
    warn: opusShare > 0.5,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const tmpDir =
    process.env.CLAUDE_JOB_DIR ??
    mkdtempSync(join(tmpdir(), "opus-burn-check-"));
  const outFile = join(tmpDir, `codeburn-export-${Date.now()}.json`);

  // Try invoking codeburn; fall back to absolute path if not on PATH.
  const codeburnBin = "/usr/local/lib/node_modules/node/bin/codeburn";

  let exportText: string | null = null;
  for (const bin of ["codeburn", codeburnBin]) {
    const result = spawnSync(bin, ["export", "--format", "json", "--output", outFile], {
      encoding: "utf8",
      // stderr may contain ExperimentalWarning about SQLite — ignore it.
    });
    if (result.status === 0) {
      try {
        exportText = readFileSync(outFile, "utf8");
      } catch {
        // File not written despite exit 0 — treat as no data.
      }
      break;
    }
  }

  // Clean up temp file.
  try {
    unlinkSync(outFile);
  } catch {
    // Best-effort cleanup.
  }

  if (!exportText || exportText.trim() === "") {
    // No data is not an error.
    process.exit(0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(exportText);
  } catch {
    // Malformed output — exit silently.
    process.exit(0);
  }

  let result: BurnResult;
  try {
    result = computeOpusBurn(parsed);
  } catch {
    // Unexpected internal error — exit silently rather than crashing the caller.
    process.exit(0);
  }

  if (result.warn) {
    const pct = (result.opusShare * 100).toFixed(1);
    const cost = result.totalCostUsd.toFixed(2);
    console.log(
      `[codeburn] WARN: Opus token share is ${pct}% today (total cost $${cost} USD) — consider switching to minimax-build alias`,
    );
  }

  process.exit(0);
}

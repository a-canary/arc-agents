// Daily budget tracker for the Opus tier (G-0006).
//
// Each role declares `daily_budget_usd` in profiles/<role>.json. This module:
//   1. estimates cost from prompt/completion token counts using Anthropic pricing,
//   2. logs every claim+model+cost as a `note` event on the issue,
//   3. blocks new claims for a role once that role's UTC-day spend exceeds budget.
//
// Spend is recomputed by scanning today's `note` events tagged `budget` for the
// role — no separate budget table. The day window is [UTC midnight, +24h).
//
// Pricing is per-million-token rates (USD). Costs in dollars.

import type { Database } from "bun:sqlite";
import { loadProfile, type Profile } from "../profiles/load";

export type Pricing = { inputPerMTok: number; outputPerMTok: number };

// Public Anthropic pricing as of 2026-05. Update here when rates change.
export const PRICING: Record<string, Pricing> = {
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4-6": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, Pricing> = PRICING,
): number {
  const p = pricing[model];
  if (!p) return 0;
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}

export function utcDayStart(nowSec: number): number {
  return nowSec - (nowSec % 86_400);
}

export type LogClaimArgs = {
  issueId: string;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  agent: string;
  now?: number;
};

export type LogResult = { costUsd: number };

export function logClaimCost(db: Database, args: LogClaimArgs): LogResult {
  const cost = estimateCost(args.model, args.inputTokens, args.outputTokens);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    tag: "budget",
    role: args.role,
    model: args.model,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cost_usd: cost,
  });
  db.run(
    `INSERT INTO issue_events (issue_id, ts, kind, agent, payload_md) VALUES (?, ?, 'note', ?, ?)`,
    [args.issueId, now, args.agent, payload],
  );
  return { costUsd: cost };
}

export function spendForRoleToday(db: Database, role: string, now: number): number {
  const dayStart = utcDayStart(now);
  const dayEnd = dayStart + 86_400;
  const rows = db
    .query<{ payload_md: string | null }, [number, number]>(
      `SELECT payload_md FROM issue_events
       WHERE kind='note' AND ts >= ? AND ts < ? AND payload_md LIKE '{"tag":"budget"%'`,
    )
    .all(dayStart, dayEnd);
  let total = 0;
  for (const r of rows) {
    if (!r.payload_md) continue;
    try {
      const p = JSON.parse(r.payload_md);
      if (p.tag === "budget" && p.role === role && typeof p.cost_usd === "number") {
        total += p.cost_usd;
      }
    } catch {
      // skip malformed
    }
  }
  return total;
}

export type BudgetCheck = {
  allowed: boolean;
  spendUsd: number;
  budgetUsd: number;
};

export function checkBudget(
  db: Database,
  role: string,
  opts: { profile?: Profile; now?: number } = {},
): BudgetCheck {
  const profile = opts.profile ?? loadProfile(role);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const spend = spendForRoleToday(db, role, now);
  return {
    allowed: spend < profile.daily_budget_usd,
    spendUsd: spend,
    budgetUsd: profile.daily_budget_usd,
  };
}

// Atomic claim wrapper used by the factory / worker-shell when claiming a
// `ready` row. Returns the claimed row id or null if no budget / no rows.
// Caller does the actual SQL claim; this just gates it and records a
// `budget-blocked` event on the candidate row when gated.
export function claimIfBudget(
  db: Database,
  args: {
    role: string;
    issueId: string;
    claimSql: () => string | null;
    profile?: Profile;
    now?: number;
    agent?: string;
  },
): { claimedId: string | null; check: BudgetCheck } {
  const check = checkBudget(db, args.role, { profile: args.profile, now: args.now });
  if (!check.allowed) {
    db.run(
      `INSERT INTO issue_events (issue_id, ts, kind, agent, payload_md) VALUES (?, ?, 'budget-blocked', ?, ?)`,
      [
        args.issueId,
        args.now ?? Math.floor(Date.now() / 1000),
        args.agent ?? "budget-tracker",
        `role=${args.role} spend=$${check.spendUsd.toFixed(2)} budget=$${check.budgetUsd.toFixed(2)}`,
      ],
    );
    return { claimedId: null, check };
  }
  return { claimedId: args.claimSql(), check };
}

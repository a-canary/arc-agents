// Pre-claim budget guard. Enforces profiles/<role>.json daily_budget_usd
// (G-0006). Reads today's spend from issue_events with kind='note' and
// payload_md matching `spend role=<R> usd=<N>` and refuses claim when the
// sum meets or exceeds the cap. Spend-recording is a follow-up; until it
// lands, spent=0 and the guard is a no-op.
import type { Database } from "bun:sqlite";
import { loadProfile } from "./load";

export type BudgetCheck = {
  role: string;
  spent_usd: number;
  cap_usd: number;
  over: boolean;
};

const SPEND_RE = /^spend\s+role=(\S+)\s+usd=([0-9]+(?:\.[0-9]+)?)/;

export function todaySpend(
  db: Database,
  role: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): number {
  // Day window in UTC. SQLite event ts is unix seconds.
  const dayStart = nowSec - (nowSec % 86400);
  const rows = db
    .query<{ payload_md: string }, [number]>(
      `SELECT payload_md FROM issue_events WHERE kind='note' AND ts >= ?`,
    )
    .all(dayStart);
  let sum = 0;
  for (const r of rows) {
    const m = SPEND_RE.exec(r.payload_md ?? "");
    if (!m) continue;
    if (m[1] !== role) continue;
    const n = Number(m[2]);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

export function checkBudget(
  db: Database,
  role: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  repoRoot?: string,
): BudgetCheck {
  const profile = loadProfile(role, repoRoot);
  const spent = todaySpend(db, role, nowSec);
  const cap = profile.daily_budget_usd;
  return { role, spent_usd: spent, cap_usd: cap, over: spent >= cap };
}

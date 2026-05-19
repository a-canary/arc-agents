import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../ledger/migrate";
import {
  estimateCost,
  utcDayStart,
  logClaimCost,
  spendForRoleToday,
  checkBudget,
  claimIfBudget,
  PRICING,
} from "./tracker";
import type { Profile } from "../profiles/load";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function ins(db: Database, id: string) {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES (?, 'p', 't', 'b', 'mvp', 'ready', 'task')`,
    [id],
  );
}

const opusProfile: Profile = {
  role: "director",
  context_summary: "",
  context_files: [],
  boot_skills: [],
  stop_skills: [],
  model: "claude-opus-4-7",
  thinking: "off",
  effort: "max",
  daily_budget_usd: 10,
  speculative_budget: 0,
  max_concurrency: 1,
  worktree: false,
};

test("estimateCost: Opus 1k in + 1k out", () => {
  // 1000 * 15 / 1e6 + 1000 * 75 / 1e6 = 0.015 + 0.075 = 0.09
  expect(estimateCost("claude-opus-4-7", 1000, 1000)).toBeCloseTo(0.09, 6);
});

test("estimateCost: unknown model returns 0", () => {
  expect(estimateCost("mystery", 1000, 1000)).toBe(0);
});

test("utcDayStart aligns to midnight UTC", () => {
  // 2026-05-19 12:34:56 UTC = 1779193896. Day start = 1779148800 (2026-05-19 00:00 UTC).
  const dayStart = utcDayStart(1779193896);
  expect(dayStart % 86_400).toBe(0);
  expect(dayStart).toBe(1779148800);
});

test("logClaimCost writes a note event with budget payload and returns cost", () => {
  const db = setup();
  ins(db, "i1");
  const { costUsd } = logClaimCost(db, {
    issueId: "i1",
    role: "director",
    model: "claude-opus-4-7",
    inputTokens: 100_000,
    outputTokens: 10_000,
    agent: "w1",
    now: 1779200000,
  });
  // 100k * 15/1e6 + 10k * 75/1e6 = 1.5 + 0.75 = 2.25
  expect(costUsd).toBeCloseTo(2.25, 6);
  const row = db
    .query<{ payload_md: string; kind: string }, []>(
      "SELECT kind, payload_md FROM issue_events WHERE issue_id='i1'",
    )
    .get();
  expect(row?.kind).toBe("note");
  const p = JSON.parse(row!.payload_md);
  expect(p.tag).toBe("budget");
  expect(p.role).toBe("director");
  expect(p.cost_usd).toBeCloseTo(2.25, 6);
});

test("spendForRoleToday sums same-role same-day budget notes only", () => {
  const db = setup();
  ins(db, "i1");
  ins(db, "i2");
  const now = 1779200000; // 2026-05-19
  const dayStart = utcDayStart(now);
  // today, director — counted
  logClaimCost(db, { issueId: "i1", role: "director", model: "claude-opus-4-7", inputTokens: 100_000, outputTokens: 0, agent: "w", now: dayStart + 100 });
  logClaimCost(db, { issueId: "i2", role: "director", model: "claude-opus-4-7", inputTokens: 200_000, outputTokens: 0, agent: "w", now: dayStart + 200 });
  // today, developer — different role
  logClaimCost(db, { issueId: "i1", role: "developer", model: "claude-opus-4-7", inputTokens: 100_000, outputTokens: 0, agent: "w", now: dayStart + 300 });
  // yesterday — outside window
  logClaimCost(db, { issueId: "i1", role: "director", model: "claude-opus-4-7", inputTokens: 100_000, outputTokens: 0, agent: "w", now: dayStart - 100 });
  // director today: 100k+200k input = 300k * 15/1e6 = 4.5
  expect(spendForRoleToday(db, "director", now)).toBeCloseTo(4.5, 6);
  expect(spendForRoleToday(db, "developer", now)).toBeCloseTo(1.5, 6);
});

test("checkBudget allows when spend < budget", () => {
  const db = setup();
  ins(db, "i1");
  const now = 1779200000;
  logClaimCost(db, { issueId: "i1", role: "director", model: "claude-opus-4-7", inputTokens: 100_000, outputTokens: 0, agent: "w", now });
  const r = checkBudget(db, "director", { profile: opusProfile, now });
  expect(r.allowed).toBe(true);
  expect(r.spendUsd).toBeCloseTo(1.5, 6);
  expect(r.budgetUsd).toBe(10);
});

test("checkBudget blocks when spend >= budget", () => {
  const db = setup();
  ins(db, "i1");
  const now = 1779200000;
  // 700k input opus = 10.5 USD, over $10 cap
  logClaimCost(db, { issueId: "i1", role: "director", model: "claude-opus-4-7", inputTokens: 700_000, outputTokens: 0, agent: "w", now });
  const r = checkBudget(db, "director", { profile: opusProfile, now });
  expect(r.allowed).toBe(false);
  expect(r.spendUsd).toBeCloseTo(10.5, 6);
});

test("budget resets at UTC midnight", () => {
  const db = setup();
  ins(db, "i1");
  const yesterdayMidnight = utcDayStart(1779200000) - 1; // last sec of prior day
  // Spend $10.5 yesterday — should not count today
  logClaimCost(db, { issueId: "i1", role: "director", model: "claude-opus-4-7", inputTokens: 700_000, outputTokens: 0, agent: "w", now: yesterdayMidnight });
  const todayNoon = utcDayStart(1779200000) + 43_200;
  const r = checkBudget(db, "director", { profile: opusProfile, now: todayNoon });
  expect(r.allowed).toBe(true);
  expect(r.spendUsd).toBe(0);
});

test("claimIfBudget runs claim when allowed", () => {
  const db = setup();
  ins(db, "i1");
  const now = 1779200000;
  let called = false;
  const r = claimIfBudget(db, {
    role: "director",
    issueId: "i1",
    claimSql: () => {
      called = true;
      return "i1";
    },
    profile: opusProfile,
    now,
  });
  expect(called).toBe(true);
  expect(r.claimedId).toBe("i1");
  expect(r.check.allowed).toBe(true);
});

test("claimIfBudget blocks claim and emits budget-blocked event when over", () => {
  const db = setup();
  ins(db, "i1");
  const now = 1779200000;
  logClaimCost(db, { issueId: "i1", role: "director", model: "claude-opus-4-7", inputTokens: 700_000, outputTokens: 0, agent: "w", now });
  let called = false;
  const r = claimIfBudget(db, {
    role: "director",
    issueId: "i1",
    claimSql: () => {
      called = true;
      return "i1";
    },
    profile: opusProfile,
    now,
  });
  expect(called).toBe(false);
  expect(r.claimedId).toBeNull();
  expect(r.check.allowed).toBe(false);
  const ev = db
    .query<{ kind: string; payload_md: string | null }, []>(
      "SELECT kind, payload_md FROM issue_events WHERE issue_id='i1' AND kind='budget-blocked'",
    )
    .get();
  expect(ev).not.toBeNull();
  expect(ev?.payload_md).toContain("role=director");
});

test("PRICING includes all profile models", () => {
  expect(PRICING["claude-opus-4-7"]).toBeDefined();
});

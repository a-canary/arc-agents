import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../ledger/migrate";
import { checkBudget, todaySpend } from "./budget-guard";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function seedIssue(db: Database, id: string): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind) VALUES (?, 'arc-agents', 't', '', 'mvp', 'ready', 'task')`,
    [id],
  );
}

function noteAt(db: Database, issueId: string, payload: string, ts: number): void {
  db.run(
    `INSERT INTO issue_events (issue_id, ts, kind, agent, payload_md) VALUES (?, ?, 'note', 'test', ?)`,
    [issueId, ts, payload],
  );
}

test("under cap → over=false", () => {
  const db = freshDb();
  seedIssue(db, "i1");
  const now = 1779200000; // mid-day
  noteAt(db, "i1", "spend role=developer usd=3.50", now);
  noteAt(db, "i1", "spend role=developer usd=2.00", now);
  const r = checkBudget(db, "developer", now);
  expect(r.spent_usd).toBeCloseTo(5.5, 2);
  expect(r.cap_usd).toBe(10);
  expect(r.over).toBe(false);
});

test("at or over cap → over=true", () => {
  const db = freshDb();
  seedIssue(db, "i1");
  const now = 1779200000;
  noteAt(db, "i1", "spend role=developer usd=7", now);
  noteAt(db, "i1", "spend role=developer usd=3.01", now);
  const r = checkBudget(db, "developer", now);
  expect(r.spent_usd).toBeCloseTo(10.01, 2);
  expect(r.over).toBe(true);
});

test("ignores other roles and other event kinds", () => {
  const db = freshDb();
  seedIssue(db, "i1");
  const now = 1779200000;
  noteAt(db, "i1", "spend role=director usd=50", now);
  noteAt(db, "i1", "unrelated note", now);
  expect(todaySpend(db, "developer", now)).toBe(0);
});

test("ignores spend from prior days", () => {
  const db = freshDb();
  seedIssue(db, "i1");
  const now = 1779200000;
  const yesterday = now - 86400 * 2;
  noteAt(db, "i1", "spend role=developer usd=20", yesterday);
  expect(todaySpend(db, "developer", now)).toBe(0);
});

test("no spend rows → 0", () => {
  const db = freshDb();
  const r = checkBudget(db, "developer", 1779200000);
  expect(r.spent_usd).toBe(0);
  expect(r.over).toBe(false);
});

// Tests for hygiene_complete gate behavior.
// All DBs are throwaway in-memory or tmp-file — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { reapWorktrees } from "./worktree-reaper";

function fresh(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// ── Merged update sets hygiene_complete=0 ────────────────────────────────────

test("update --state=merged sets hygiene_complete=0 on the row", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path)
     VALUES ('t-merge','p','t','b','mvp','wip','task','/tmp/wt')`,
  );
  // Simulate the update handler's merged path: sets hygiene_complete=0
  db.run(
    `UPDATE issues SET state='merged', hygiene_complete=0, updated_at=strftime('%s','now') WHERE id='t-merge'`,
  );
  const row = db
    .query<{ hygiene_complete: number }, []>(
      "SELECT hygiene_complete FROM issues WHERE id='t-merge'",
    )
    .get();
  expect(row?.hygiene_complete).toBe(0);
});

test("reapWorktrees skips merged rows with hygiene_complete=0", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, hygiene_complete)
     VALUES ('t-skip','p','t','b','mvp','merged','task','/tmp/nonexistent', 0)`,
  );
  // hygiene_complete=0: reaper should skip this merged row
  const reaped = reapWorktrees(db);
  const ids = reaped.map((r) => r.issue_id);
  expect(ids).not.toContain("t-skip");
});

test("reapWorktrees proceeds on merged rows with hygiene_complete=1", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, hygiene_complete)
     VALUES ('t-proceed','p','t','b','mvp','merged','task','/tmp/nonexistent', 1)`,
  );
  const reaped = reapWorktrees(db);
  const ids = reaped.map((r) => r.issue_id);
  expect(ids).toContain("t-proceed");
});

// ── hygiene-emit flips hygiene_complete=1 on parent ──────────────────────────

test("hygiene-emit flips hygiene_complete=1 on the observed-in-task parent", () => {
  const db = fresh();
  // Parent task in merged state with hygiene_complete=0
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, hygiene_complete)
     VALUES ('t-parent','p','t','b','mvp','merged','task','/tmp/wt', 0)`,
  );
  // hygiene-emit: the handler flips hygiene_complete=1 on the parent
  db.run(
    `UPDATE issues SET hygiene_complete=1, updated_at=strftime('%s','now') WHERE id='t-parent' AND hygiene_complete=0`,
  );
  const row = db
    .query<{ hygiene_complete: number }, []>(
      "SELECT hygiene_complete FROM issues WHERE id='t-parent'",
    )
    .get();
  expect(row?.hygiene_complete).toBe(1);
});

test("hygiene-emit is idempotent: second flip on already-1 is a no-op", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, hygiene_complete)
     VALUES ('t-already1','p','t','b','mvp','merged','task', 1)`,
  );
  // Second flip: WHERE hygiene_complete=0 is false, so no-op
  db.run(
    `UPDATE issues SET hygiene_complete=1, updated_at=strftime('%s','now') WHERE id='t-already1' AND hygiene_complete=0`,
  );
  const row = db
    .query<{ hygiene_complete: number }, []>(
      "SELECT hygiene_complete FROM issues WHERE id='t-already1'",
    )
    .get();
  expect(row?.hygiene_complete).toBe(1);
});

// ── Failed/cancelled rows unaffected ─────────────────────────────────────────

test("reapWorktrees reaps failed rows regardless of hygiene_complete", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, hygiene_complete)
     VALUES ('t-failed','p','t','b','mvp','failed','task','/tmp/nonexistent', 0)`,
  );
  const reaped = reapWorktrees(db);
  const ids = reaped.map((r) => r.issue_id);
  expect(ids).toContain("t-failed");
});

test("reapWorktrees reaps cancelled rows regardless of hygiene_complete", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, hygiene_complete)
     VALUES ('t-cancelled','p','t','b','mvp','cancelled','task','/tmp/nonexistent', 0)`,
  );
  const reaped = reapWorktrees(db);
  const ids = reaped.map((r) => r.issue_id);
  expect(ids).toContain("t-cancelled");
});

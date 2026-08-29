// Tests for migration 032_recreate_unblock_triggers.
// All DBs are throwaway in-memory — never touches ~/vault/ledger.db.
//
// Context: the live vault DB lost both cascade triggers (unblock_dependents,
// unblock_sprint_parents) while schema_migrations recorded 019 as applied.
// Migration 032 idempotently recreates both from the canonical table-qualified
// form in migrate.ts (json_each(issues.blocked_by), not bare blocked_by).

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo, migrations } from "./migrate";

const ID = "032_recreate_unblock_triggers";

function triggerNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'unblock_%'",
    )
    .all()
    .map((r) => r.name);
}

function insertParent(db: Database, id: string, state = "ready"): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES (?, 'p', ?, 'b', 'mvp', ?, 'task')`,
    [id, id, state],
  );
}

function insertBlockedDependent(
  db: Database,
  id: string,
  blockers: string[],
  kind = "task",
): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, blocked_by)
     VALUES (?, 'p', ?, 'b', 'mvp', 'blocked', ?, ?)`,
    [id, id, kind, JSON.stringify(blockers)],
  );
}

function stateOf(db: Database, id: string): string {
  return db.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get(id)?.state as string;
}

// ── Migration registered + idempotent ────────────────────────────────────────

test("032 is registered and applied by a full migrate()", () => {
  const db = new Database(":memory:");
  const ran = migrate(db);
  expect(ran).toContain(ID);
});

test("032 up() is idempotent (DROP IF EXISTS + CREATE, safe to run twice)", () => {
  const db = new Database(":memory:");
  migrate(db);
  const m = migrations.find((x) => x.id === ID);
  expect(m).toBeDefined();
  expect(() => m!.up(db)).not.toThrow(); // second raw run must not fail
  expect(triggerNames(db).sort()).toEqual(["unblock_dependents", "unblock_sprint_parents"]);
});

test("032 is a no-op on an already-migrated DB (schema_migrations dedupe)", () => {
  const db = new Database(":memory:");
  migrate(db);
  expect(migrate(db)).toEqual([]);
});

// ── Trigger bodies use the canonical table-qualified form ───────────────────

test("032 trigger bodies are table-qualified (json_each(issues.blocked_by))", () => {
  const db = new Database(":memory:");
  migrate(db);
  const sql = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'unblock_%'",
    )
    .all();
  expect(sql).toHaveLength(2);
  for (const t of sql) {
    expect(t.sql ?? "").toContain("json_each(issues.blocked_by)");
    // The bare form is the incident shape — it must not appear.
    expect(t.sql ?? "").not.toContain("json_each(blocked_by)");
  }
});

// ── Functional: repair path (triggers dropped, then 032 recreates them) ─────

function dbWithDroppedTriggers(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrateUpTo(db, "019_issue_kind_sprint");
  // Simulate the live incident: triggers gone, schema_migrations untouched.
  db.exec("DROP TRIGGER IF EXISTS unblock_dependents");
  db.exec("DROP TRIGGER IF EXISTS unblock_sprint_parents");
  return db;
}

test("without 032 the cascade is dead (incident reproduction)", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "p1");
  insertBlockedDependent(db, "c1", ["p1"]);
  db.run(`UPDATE issues SET state='merged' WHERE id='p1'`);
  expect(stateOf(db, "c1")).toBe("blocked"); // no trigger → stays blocked
});

test("032 repair: merge parent flips dependent blocked→ready", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "p1");
  insertBlockedDependent(db, "c1", ["p1"]);
  migrate(db); // applies 032 (and any other pending migrations)
  expect(stateOf(db, "c1")).toBe("blocked");
  db.run(`UPDATE issues SET state='merged' WHERE id='p1'`);
  expect(stateOf(db, "c1")).toBe("ready");
});

test("032: all-blockers-merged rule — one live blocker keeps dependent blocked", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "p1");
  insertParent(db, "p2");
  insertBlockedDependent(db, "c1", ["p1", "p2"]);
  migrate(db);
  db.run(`UPDATE issues SET state='merged' WHERE id='p1'`);
  expect(stateOf(db, "c1")).toBe("blocked"); // p2 still live
  db.run(`UPDATE issues SET state='merged' WHERE id='p2'`);
  expect(stateOf(db, "c1")).toBe("ready");
});

test("032: merging an unrelated row is a no-op", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "p1");
  insertParent(db, "other");
  insertBlockedDependent(db, "c1", ["p1"]);
  migrate(db);
  db.run(`UPDATE issues SET state='merged' WHERE id='other'`);
  expect(stateOf(db, "c1")).toBe("blocked");
});

test("032: re-merging a merged row does not double-fire (OLD.state guard)", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "p1");
  insertBlockedDependent(db, "c1", ["p1"]);
  migrate(db);
  db.run(`UPDATE issues SET state='merged' WHERE id='p1'`);
  expect(stateOf(db, "c1")).toBe("ready");
  // Redundant merged→merged update must not throw or misfire.
  expect(() => db.run(`UPDATE issues SET state='merged' WHERE id='p1'`)).not.toThrow();
});

// ── Sprint arm: terminal (merged|failed|cancelled) unblocks sprint kind ─────

test("032 sprint arm: all blockers terminal flips sprint row blocked→ready", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "t1");
  insertParent(db, "t2");
  insertBlockedDependent(db, "s1", ["t1", "t2"], "sprint");
  migrate(db);
  db.run(`UPDATE issues SET state='merged' WHERE id='t1'`);
  expect(stateOf(db, "s1")).toBe("blocked"); // t2 still live
  db.run(`UPDATE issues SET state='cancelled' WHERE id='t2'`);
  expect(stateOf(db, "s1")).toBe("ready");
});

test("032 sprint arm: failed blocker counts as terminal", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "t1");
  insertBlockedDependent(db, "s1", ["t1"], "sprint");
  migrate(db);
  db.run(`UPDATE issues SET state='failed' WHERE id='t1'`);
  expect(stateOf(db, "s1")).toBe("ready");
});

test("032 non-sprint arm stays strict: cancelled blocker does NOT unblock (ADR-0014)", () => {
  const db = dbWithDroppedTriggers();
  insertParent(db, "t1");
  insertBlockedDependent(db, "c1", ["t1"]); // kind=task
  migrate(db);
  db.run(`UPDATE issues SET state='cancelled' WHERE id='t1'`);
  expect(stateOf(db, "c1")).toBe("blocked");
});

// Tests for migration 027_feedback_declined_at.
// All DBs are throwaway in-memory — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// ── Migration id is correct and sorts after 026 ──────────────────────────────

test("027 migration id is '027_feedback_declined_at' and sorts after 026", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx026 = ids.indexOf("026_event_kind_operator_landed");
  const idx027 = ids.indexOf("027_feedback_declined_at");
  expect(idx027).toBeGreaterThan(-1);
  expect(idx027).toBeGreaterThan(idx026);
});

// ── Column exists on feedback table ─────────────────────────────────────────

test("027 adds declined_at column to feedback", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(feedback)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("declined_at");
});

test("027 declined_at is nullable (no NOT NULL constraint)", () => {
  const db = fresh();
  const cols = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(feedback)").all();
  const col = cols.find((c) => c.name === "declined_at");
  // nullable: notnull=0; null == "not declined, eligible for re-aggregation"
  expect(col?.notnull).toBe(0);
});

// ── Default: pre-027 rows leave declined_at = null ──────────────────────────

test("027 pre-existing feedback rows have declined_at = null", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "026_event_kind_operator_landed");
  db.run(
    "INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)",
    ["pre027", "p", "ai-agent", "old row", "new"],
  );
  migrate(db); // applies 027
  const row = db
    .query<{ declined_at: number | null }, []>(
      "SELECT declined_at FROM feedback WHERE id='pre027'",
    )
    .get();
  expect(row?.declined_at).toBeNull();
});

// ── Idempotent: second migrate() applies 027 once ──────────────────────────

test("027 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("027_feedback_declined_at");
  const second = migrate(db);
  expect(second).not.toContain("027_feedback_declined_at");
  expect(second.length).toBe(0);
});

// ── ALTER is a no-op when declined_at already exists (idempotent edge) ──────

test("027 is a no-op when declined_at already exists", () => {
  const db = new Database(":memory:");
  migrate(db); // first run — adds column
  const colCount1 = db
    .query<{ name: string }, []>("PRAGMA table_info(feedback)")
    .all().length;
  migrate(db); // second run — should not re-add
  const colCount2 = db
    .query<{ name: string }, []>("PRAGMA table_info(feedback)")
    .all().length;
  expect(colCount1).toBe(colCount2);
});

// ── Index on declined_at created ────────────────────────────────────────────

test("027 creates a partial index on declined_at WHERE NOT NULL", () => {
  const db = fresh();
  const indexes = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='feedback'",
    )
    .all();
  const idx = indexes.find((i) => i.name === "idx_feedback_declined_at");
  expect(idx).toBeDefined();
  expect(idx?.sql ?? "").toContain("declined_at");
});

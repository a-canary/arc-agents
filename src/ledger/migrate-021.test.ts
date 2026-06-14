// Tests for migration 021_hygiene_complete.
// All DBs are throwaway in-memory or tmp-file — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// ── Migration id is correct and sorts after 020 ──────────────────────────────

test("021 migration id is '021_hygiene_complete' and sorts after 020", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx020 = ids.indexOf("020_blog_table");
  const idx021 = ids.indexOf("021_hygiene_complete");
  expect(idx021).toBeGreaterThan(-1);
  expect(idx021).toBeGreaterThan(idx020);
});

// ── Column exists and has correct definition ──────────────────────────────────

test("021 adds hygiene_complete column to issues", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(issues)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("hygiene_complete");
});

test("021 hygiene_complete is NOT NULL", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string; notnull: number }, []>("PRAGMA table_info(issues)")
    .all();
  const col = cols.find((c) => c.name === "hygiene_complete");
  expect(col?.notnull).toBe(1);
});

test("021 hygiene_complete defaults to 1", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string; dflt_value: string | null }, []>("PRAGMA table_info(issues)")
    .all();
  const col = cols.find((c) => c.name === "hygiene_complete");
  expect(col?.dflt_value).toBe("1");
});

// ── CHECK constraint: only 0 or 1 allowed ─────────────────────────────────────

test("021 hygiene_complete CHECK rejects values other than 0 or 1", () => {
  const db = fresh();
  // Pre-021 rows: hygiene_complete=1 is the default, so the constraint is
  // satisfied on insert.  Try inserting with explicit 0 and 1 (should succeed).
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, hygiene_complete)
       VALUES ('t-021-ok','p','t','b','mvp','ready','task', 0)`,
    ),
  ).not.toThrow();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, hygiene_complete)
       VALUES ('t-021-ok2','p','t','b','mvp','ready','task', 1)`,
    ),
  ).not.toThrow();
  // Invalid value 2 should be rejected
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, hygiene_complete)
       VALUES ('t-021-bad','p','t','b','mvp','ready','task', 2)`,
    ),
  ).toThrow();
});

// ── Default value on pre-existing rows ────────────────────────────────────────

test("021 pre-existing rows default hygiene_complete to 1", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "020_blog_table");
  // Insert a row before 021 runs
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('pre021','p','Pre-existing','b','mvp','ready','task')`,
  );
  migrate(db); // applies 021
  const row = db
    .query<{ hygiene_complete: number }, []>(
      "SELECT hygiene_complete FROM issues WHERE id='pre021'",
    )
    .get();
  expect(row?.hygiene_complete).toBe(1);
});

// ── Idempotent: running migrate twice applies 021 once ───────────────────────

test("021 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("021_hygiene_complete");
  const second = migrate(db);
  expect(second).not.toContain("021_hygiene_complete");
  expect(second.length).toBe(0);
});

// ── Pre-existing issues rows survive 021 intact ────────────────────────────────

test("021 pre-existing issues rows are untouched", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "020_blog_table");
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('pre021-col','myproject','Pre-existing','body','mvp','ready','task')`,
  );
  migrate(db); // applies 021
  const row = db
    .query<{ id: string; title: string }, []>("SELECT id, title FROM issues WHERE id='pre021-col'")
    .get();
  expect(row?.title).toBe("Pre-existing");
});

// ── ALTER TABLE is safe when column already exists (idempotent edge) ───────────

test("021 is a no-op when hygiene_complete already exists", () => {
  const db = new Database(":memory:");
  migrate(db); // first run — adds column
  const colCount1 = db
    .query<{ name: string }, []>("PRAGMA table_info(issues)")
    .all().length;
  migrate(db); // second run — should not re-add
  const colCount2 = db
    .query<{ name: string }, []>("PRAGMA table_info(issues)")
    .all().length;
  expect(colCount1).toBe(colCount2);
});

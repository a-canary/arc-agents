// Tests for migration 020_blog_table.
// All DBs are throwaway in-memory or tmp-file — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  // SQLite FK constraints are OFF by default; enable them globally so the
  // REFERENCES clause on origin_task_id is actually enforced.
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// ── Migration id is correct and sorts after 019 ──────────────────────────────

test("020 migration id is '020_blog_table' and sorts after 019", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx019 = ids.indexOf("019_issue_kind_sprint");
  const idx020 = ids.indexOf("020_blog_table");
  expect(idx020).toBeGreaterThan(-1);
  expect(idx020).toBeGreaterThan(idx019);
});

// ── blog table columns ─────────────────────────────────────────────────────────

test("020 creates blog table with all required columns", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(blog)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("id");
  expect(cols).toContain("project");
  expect(cols).toContain("title");
  expect(cols).toContain("body_md");
  expect(cols).toContain("artifact_path");
  expect(cols).toContain("origin_task_id");
  expect(cols).toContain("created_at");
});

test("020 blog id is PRIMARY KEY", () => {
  const db = fresh();
  const cols = db.query<{ name: string; pk: number }, []>("PRAGMA table_info(blog)").all();
  const idCol = cols.find((c) => c.name === "id");
  expect(idCol?.pk).toBe(1);
});

test("020 blog project NOT NULL", () => {
  const db = fresh();
  const cols = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(blog)").all();
  const projectCol = cols.find((c) => c.name === "project");
  expect(projectCol?.notnull).toBe(1);
});

test("020 blog origin_task_id is nullable (manual posts have no origin)", () => {
  const db = fresh();
  const cols = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(blog)").all();
  const col = cols.find((c) => c.name === "origin_task_id");
  expect(col?.notnull).toBe(0); // nullable
});

test("020 blog artifact_path is nullable", () => {
  const db = fresh();
  const cols = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(blog)").all();
  const col = cols.find((c) => c.name === "artifact_path");
  expect(col?.notnull).toBe(0);
});

// ── Indexes ───────────────────────────────────────────────────────────────────

test("020 creates idx_blog_project", () => {
  const db = fresh();
  const indexes = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r) => r.name);
  expect(indexes).toContain("idx_blog_project");
});

test("020 creates idx_blog_created_at DESC", () => {
  const db = fresh();
  const indexes = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='blog'",
    )
    .all();
  const idx = indexes.find((i) => i.name === "idx_blog_created_at");
  expect(idx).toBeDefined();
});

test("020 creates idx_blog_origin_task_id partial index", () => {
  const db = fresh();
  const indexes = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='blog'",
    )
    .all();
  const idx = indexes.find((i) => i.name === "idx_blog_origin_task_id");
  expect(idx).toBeDefined();
  // Partial index WHERE clause should exclude NULLs
  expect(idx?.sql).toContain("WHERE");
});

// ── FK: origin_task_id references issues(id) ──────────────────────────────────

test("020 origin_task_id FK enforces referential integrity", () => {
  const db = fresh();
  // Insert an issue first
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('t-ref','p','ref','b','mvp','ready','task')`,
  );
  // Valid FK → ok
  expect(() =>
    db.run(
      `INSERT INTO blog (id, project, title, body_md, origin_task_id)
       VALUES ('b1','p','t','b','t-ref')`,
    ),
  ).not.toThrow();

  // Invalid FK → constraint error
  expect(() =>
    db.run(
      `INSERT INTO blog (id, project, title, body_md, origin_task_id)
       VALUES ('b2','p','t','b','nonexistent')`,
    ),
  ).toThrow();
});

// ── Insert round-trip ──────────────────────────────────────────────────────────

test("020 insert a complete blog row and read it back", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('ot1','myproject','origin task','body','mvp','merged','task')`,
  );
  db.run(
    `INSERT INTO blog (id, project, title, body_md, artifact_path, origin_task_id)
     VALUES ('b1','myproject','My Post','# Hello\nWorld','/tmp/art.png','ot1')`,
  );
  const row = db
    .query<{
      id: string;
      project: string;
      title: string;
      body_md: string;
      artifact_path: string | null;
      origin_task_id: string | null;
    }, []>("SELECT * FROM blog WHERE id='b1'")
    .get();
  expect(row?.id).toBe("b1");
  expect(row?.project).toBe("myproject");
  expect(row?.title).toBe("My Post");
  expect(row?.body_md).toBe("# Hello\nWorld");
  expect(row?.artifact_path).toBe("/tmp/art.png");
  expect(row?.origin_task_id).toBe("ot1");
});

test("020 insert blog post with no origin_task_id (manual post)", () => {
  const db = fresh();
  db.run(
    `INSERT INTO blog (id, project, title, body_md)
     VALUES ('b-manual','p','Manual Post','Written by hand')`,
  );
  const row = db
    .query<{ id: string; origin_task_id: string | null }, []>(
      "SELECT id, origin_task_id FROM blog WHERE id='b-manual'",
    )
    .get();
  expect(row?.origin_task_id).toBeNull();
});

// ── created_at default ─────────────────────────────────────────────────────────

test("020 created_at defaults to current unix timestamp", () => {
  const db = fresh();
  db.run(
    `INSERT INTO blog (id, project, title, body_md) VALUES ('b-ts','p','t','b')`,
  );
  const row = db
    .query<{ created_at: number }, []>("SELECT created_at FROM blog WHERE id='b-ts'")
    .get();
  expect(row?.created_at).toBeGreaterThan(0);
});

// ── Idempotent: running migrate twice applies 020 once ───────────────────────

test("020 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("020_blog_table");
  const second = migrate(db);
  expect(second).not.toContain("020_blog_table");
  expect(second.length).toBe(0);
});

// ── Pre-existing blog rows survive re-apply (idempotency of IF NOT EXISTS) ────

test("020 blog rows survive a second migrate() call", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.run(
    `INSERT INTO blog (id, project, title, body_md) VALUES ('b-persist','p','t','b')`,
  );
  migrate(db); // re-apply (no-op for 020)
  const row = db
    .query<{ id: string }, []>("SELECT id FROM blog WHERE id='b-persist'")
    .get();
  expect(row?.id).toBe("b-persist");
});

// ── Pre-existing issues rows survive 020 intact ───────────────────────────────

test("020 pre-existing issues rows are untouched", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "019_issue_kind_sprint");
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('pre020','myproject','Pre-existing','body','mvp','ready','task')`,
  );
  migrate(db); // applies 020
  const row = db
    .query<{ id: string; title: string }, []>("SELECT id, title FROM issues WHERE id='pre020'")
    .get();
  expect(row?.title).toBe("Pre-existing");
});

// ── Duplicate PK rejected ─────────────────────────────────────────────────────

test("020 duplicate blog.id raises constraint error", () => {
  const db = fresh();
  db.run(
    `INSERT INTO blog (id, project, title, body_md) VALUES ('b-dup','p','t1','b1')`,
  );
  expect(() =>
    db.run(
      `INSERT INTO blog (id, project, title, body_md) VALUES ('b-dup','p','t2','b2')`,
    ),
  ).toThrow();
});

// Tests for migration 029_blog_pr_url.
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

// ── Migration id is correct and sorts after 028 ──────────────────────────────

test("029 migration id is '029_blog_pr_url' and sorts after 028", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx028 = ids.indexOf("028_prd_relationships");
  const idx029 = ids.indexOf("029_blog_pr_url");
  expect(idx029).toBeGreaterThan(-1);
  expect(idx029).toBeGreaterThan(idx028);
});

// ── Columns added to blog table ──────────────────────────────────────────────

test("029 adds pr_url and pr_state columns to blog", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(blog)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("pr_url");
  expect(cols).toContain("pr_state");
});

test("029 pr_url and pr_state are nullable (no NOT NULL constraint)", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string; notnull: number }, []>("PRAGMA table_info(blog)")
    .all();
  for (const name of ["pr_url", "pr_state"] as const) {
    const col = cols.find((c) => c.name === name);
    // nullable: notnull=0; null == "this post has no PR link yet"
    expect(col?.notnull).toBe(0);
  }
});

// ── CHECK constraint on pr_state vocabulary ──────────────────────────────────

test("029 CHECK admits open / merged / closed", () => {
  const db = fresh();
  db.run(
    `INSERT INTO blog (id, project, title, body_md, pr_url, pr_state)
     VALUES ('p1','p','a','b','https://x/1','open')`,
  );
  db.run(
    `INSERT INTO blog (id, project, title, body_md, pr_url, pr_state)
     VALUES ('p2','p','b','b','https://x/2','merged')`,
  );
  db.run(
    `INSERT INTO blog (id, project, title, body_md, pr_url, pr_state)
     VALUES ('p3','p','c','b','https://x/3','closed')`,
  );
  const rows = db
    .query<{ id: string; pr_state: string }, []>(
      "SELECT id, pr_state FROM blog ORDER BY pr_state",
    )
    .all();
  expect(rows.map((r) => r.pr_state)).toEqual(["closed", "merged", "open"]);
});

test("029 CHECK rejects invalid pr_state values", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO blog (id, project, title, body_md, pr_url, pr_state)
       VALUES ('pbad','p','x','b','https://x/1','approved')`,
    ),
  ).toThrow();
  expect(() =>
    db.run(
      `INSERT INTO blog (id, project, title, body_md, pr_url, pr_state)
       VALUES ('pbad2','p','x','b','https://x/1','MERGED')`,
    ),
  ).toThrow();
});

test("029 CHECK allows pr_state = NULL (absent PR is first-class)", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO blog (id, project, title, body_md)
       VALUES ('pnull','p','no pr','b')`,
    ),
  ).not.toThrow();
});

// ── Pre-029 blog rows keep pr_url/pr_state = null ────────────────────────────

test("029 pre-existing blog rows have pr_url and pr_state = null", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "028_prd_relationships");
  db.run(
    `INSERT INTO blog (id, project, title, body_md, created_at)
     VALUES ('pre029','p','old row','b',1000)`,
  );
  migrate(db); // applies 029
  const row = db
    .query<{ pr_url: string | null; pr_state: string | null }, []>(
      "SELECT pr_url, pr_state FROM blog WHERE id='pre029'",
    )
    .get();
  expect(row?.pr_url).toBeNull();
  expect(row?.pr_state).toBeNull();
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("029 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("029_blog_pr_url");
  const second = migrate(db);
  expect(second).not.toContain("029_blog_pr_url");
  expect(second.length).toBe(0);
});

test("029 is a no-op when columns already exist (idempotent edge)", () => {
  const db = new Database(":memory:");
  migrate(db); // first run — adds columns
  const colCount1 = db
    .query<{ name: string }, []>("PRAGMA table_info(blog)")
    .all().length;
  migrate(db); // second run — should not re-add
  const colCount2 = db
    .query<{ name: string }, []>("PRAGMA table_info(blog)")
    .all().length;
  expect(colCount1).toBe(colCount2);
});

// ── Partial index on pr_url created ──────────────────────────────────────────

test("029 creates a partial index on pr_url WHERE NOT NULL", () => {
  const db = fresh();
  const indexes = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='blog'",
    )
    .all();
  const idx = indexes.find((i) => i.name === "idx_blog_pr_url");
  expect(idx).toBeDefined();
  expect(idx?.sql ?? "").toContain("pr_url");
  expect(idx?.sql ?? "").toContain("IS NOT NULL");
});
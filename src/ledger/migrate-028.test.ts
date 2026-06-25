// Tests for migration 028_prd_relationships.
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

// ── Migration id is correct and sorts after 027 ──────────────────────────────

test("028 migration id is '028_prd_relationships' and sorts after 027", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx027 = ids.indexOf("027_feedback_declined_at");
  const idx028 = ids.indexOf("028_prd_relationships");
  expect(idx028).toBeGreaterThan(-1);
  expect(idx028).toBeGreaterThan(idx027);
});

// ── Table exists with expected columns ────────────────────────────────────────

test("028 creates prd_relationships table with required columns", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(prd_relationships)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("prd_id");
  expect(cols).toContain("other_prd_id");
  expect(cols).toContain("kind");
  expect(cols).toContain("created_at");
});

test("028 (prd_id, other_prd_id) is the primary key", () => {
  const db = fresh();
  const pk = db
    .query<{ name: string }, []>("PRAGMA table_info(prd_relationships)")
    .all()
    .filter((c) => (c as unknown as { pk: number }).pk > 0)
    .map((c) => c.name);
  expect(pk).toContain("prd_id");
  expect(pk).toContain("other_prd_id");
});

// ── CHECK constraint on kind ──────────────────────────────────────────────────

test("028 CHECK admits orthogonal / replace / dependency / fork", () => {
  const db = fresh();
  // Need two real issues rows to satisfy REFERENCES (foreign keys). Insert
  // four pairs (one per kind) so each (prd_id, other_prd_id) is unique — the
  // PRIMARY KEY (prd_id, other_prd_id) would reject a duplicate pair regardless
  // of kind, so testing all four kinds requires four distinct pairs.
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('prd-a','p','a','b','mvp','review','prd'),
            ('prd-b','p','b','b','mvp','review','prd'),
            ('prd-c','p','c','b','mvp','review','prd'),
            ('prd-d','p','d','b','mvp','review','prd')`,
  );
  const pairs: [string, string][] = [
    ["prd-a", "prd-b"],
    ["prd-a", "prd-c"],
    ["prd-a", "prd-d"],
    ["prd-b", "prd-c"],
  ];
  for (const [i, kind] of (["orthogonal", "replace", "dependency", "fork"] as const).entries()) {
    expect(() =>
      db.run(
        `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, ?)`,
        [pairs[i]![0], pairs[i]![1], kind],
      ),
    ).not.toThrow();
  }
  const rows = db
    .query<{ kind: string }, []>("SELECT kind FROM prd_relationships ORDER BY kind")
    .all();
  expect(rows.map((r) => r.kind)).toEqual(["dependency", "fork", "orthogonal", "replace"]);
});

test("028 CHECK rejects invalid kind values", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('prd-x','p','x','b','mvp','review','prd'),
            ('prd-y','p','y','b','mvp','review','prd')`,
  );
  expect(() =>
    db.run(
      `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, ?)`,
      ["prd-x", "prd-y", "garbage"],
    ),
  ).toThrow();
  expect(() =>
    db.run(
      `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, ?)`,
      ["prd-x", "prd-y", "DEPENDENCY"],
    ),
  ).toThrow();
});

// ── Primary key dedupes (no duplicate pairs) ──────────────────────────────────

test("028 primary key rejects duplicate (prd_id, other_prd_id) pairs", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('prd-a','p','a','b','mvp','review','prd'),
            ('prd-b','p','b','b','mvp','review','prd')`,
  );
  db.run(
    `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, 'orthogonal')`,
    ["prd-a", "prd-b"],
  );
  expect(() =>
    db.run(
      `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, 'replace')`,
      ["prd-a", "prd-b"],
    ),
  ).toThrow();
});

// ── FK cascade: deleting a PRD removes its relationships ──────────────────────

test("028 FK ON DELETE CASCADE removes rows when a PRD is deleted", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('prd-a','p','a','b','mvp','review','prd'),
            ('prd-b','p','b','b','mvp','review','prd')`,
  );
  db.run(
    `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, 'orthogonal')`,
    ["prd-a", "prd-b"],
  );
  db.run(`DELETE FROM issues WHERE id='prd-a'`);
  const rows = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM prd_relationships")
    .get();
  expect(rows?.n).toBe(0);
});

// ── Idempotency ───────────────────────────────────────────────────────────────

test("028 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("028_prd_relationships");
  const second = migrate(db);
  expect(second).not.toContain("028_prd_relationships");
  expect(second.length).toBe(0);
});

// ── Insert with valid PRD rows survives a fresh migrate() ────────────────────

test("028 pre-existing PRD rows can have relationships inserted after migrate", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "023_feedback_theme");
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('prd-pre-a','p','a','b','mvp','review','prd'),
            ('prd-pre-b','p','b','b','mvp','review','prd')`,
  );
  migrate(db); // applies 028
  db.run(
    `INSERT INTO prd_relationships (prd_id, other_prd_id, kind) VALUES (?, ?, 'dependency')`,
    ["prd-pre-a", "prd-pre-b"],
  );
  const row = db
    .query<{ kind: string }, []>(
      "SELECT kind FROM prd_relationships WHERE prd_id='prd-pre-a' AND other_prd_id='prd-pre-b'",
    )
    .get();
  expect(row?.kind).toBe("dependency");
});

// ── Indexes for lookup ────────────────────────────────────────────────────────

test("028 creates indexes on prd_id and other_prd_id", () => {
  const db = fresh();
  const idxs = db
    .query<{ name: string }, []>("PRAGMA index_list(prd_relationships)")
    .all()
    .map((r) => r.name);
  // Index names are idx_prd_relationships_prd / idx_prd_relationships_other
  // (the column names are truncated at the underscore split). Check the full
  // names exist instead of a substring match.
  expect(idxs).toContain("idx_prd_relationships_prd");
  expect(idxs).toContain("idx_prd_relationships_other");
});
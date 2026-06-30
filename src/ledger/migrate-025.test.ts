// Tests for migration 025_feedback_mode_author_trust.
// All DBs are throwaway in-memory or tmp-file — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo } from "./migrate";

function cols(db: Database): string[] {
  return db
    .query<{ name: string }, []>("PRAGMA table_info(feedback)")
    .all()
    .map((r) => r.name);
}

// ── Migration id sorts after 024 ─────────────────────────────────────────────

test("025 migration id is '025_feedback_mode_author_trust' and sorts after 024", () => {
  const db = new Database(":memory:");
  migrate(db);
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx024 = ids.indexOf("024_feedback_stale_superseded");
  const idx025 = ids.indexOf("025_feedback_mode_author_trust");
  expect(idx025).toBeGreaterThan(-1);
  expect(idx025).toBeGreaterThan(idx024);
});

// ── Columns exist after running up to 025 ────────────────────────────────────

test("025 adds mode and author_trust columns to feedback", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "025_feedback_mode_author_trust");
  const names = cols(db);
  expect(names).toContain("mode");
  expect(names).toContain("author_trust");
});

// ── No SQL DEFAULT (NULL means hypothesis / unstamped, decided in code) ───────

test("025 mode and author_trust have no SQL default (NULL is the unstamped state)", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "025_feedback_mode_author_trust");
  const info = db
    .query<{ name: string; dflt_value: string | null }, []>("PRAGMA table_info(feedback)")
    .all();
  expect(info.find((c) => c.name === "mode")?.dflt_value).toBeNull();
  expect(info.find((c) => c.name === "author_trust")?.dflt_value).toBeNull();
});

// ── Idempotent: a second migrate() re-run applies nothing and does not throw ──

test("025 is idempotent (second migrate() call applies it 0 more times)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("025_feedback_mode_author_trust");
  expect(() => {
    const second = migrate(db);
    expect(second).not.toContain("025_feedback_mode_author_trust");
    expect(second.length).toBe(0);
  }).not.toThrow();
});

// ── No-op when columns already exist (column count unchanged on re-run) ───────

test("025 is a no-op when mode/author_trust already exist", () => {
  const db = new Database(":memory:");
  migrate(db);
  const before = cols(db).length;
  migrate(db);
  expect(cols(db).length).toBe(before);
});

// ── A feedback row can be inserted and read with both columns set ─────────────

test("025 a feedback row round-trips with mode and author_trust set", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.run(
    `INSERT INTO feedback (id, project, source, body_md, mode, author_trust)
     VALUES ('fb-025','p','direct','please ship this','imperative','operator')`,
  );
  const row = db
    .query<{ mode: string; author_trust: string }, []>(
      "SELECT mode, author_trust FROM feedback WHERE id='fb-025'",
    )
    .get();
  expect(row?.mode).toBe("imperative");
  expect(row?.author_trust).toBe("operator");
});

// ── Legacy row (columns NULL) is valid — unstamped state round-trips ──────────

test("025 a row with NULL mode/author_trust round-trips (legacy/unstamped)", () => {
  const db = new Database(":memory:");
  migrate(db);
  db.run(
    `INSERT INTO feedback (id, project, source, body_md)
     VALUES ('fb-025-legacy','p','direct','a musing')`,
  );
  const row = db
    .query<{ mode: string | null; author_trust: string | null }, []>(
      "SELECT mode, author_trust FROM feedback WHERE id='fb-025-legacy'",
    )
    .get();
  expect(row?.mode).toBeNull();
  expect(row?.author_trust).toBeNull();
});

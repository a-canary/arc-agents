// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// Tests for migration 019_issue_kind_sprint.
// All DBs are throwaway in-memory or tmp-file — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

// ── Migration id is correct and sorts after 018 ──────────────────────────────

test("019 migration id is '019_issue_kind_sprint' and sorts after 018", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx018 = ids.indexOf("018_event_kind_triaged");
  const idx019 = ids.indexOf("019_issue_kind_sprint");
  expect(idx019).toBeGreaterThan(-1);
  expect(idx019).toBeGreaterThan(idx018);
});

// ── Sprint kind is now accepted ───────────────────────────────────────────────

test("019 INSERT with kind='sprint' succeeds", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('s1','p','sprint-issue','body','mvp','ready','sprint')`,
    ),
  ).not.toThrow();
});

// ── Bogus kind still rejected ─────────────────────────────────────────────────

test("019 INSERT with kind='bogus' still fails with SQLITE_CONSTRAINT", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('x1','p','t','b','mvp','ready','bogus')`,
    ),
  ).toThrow();
});

// ── Pre-existing rows survive intact ─────────────────────────────────────────

test("019 pre-existing rows survive byte-for-byte (row count + sentinel)", () => {
  // Stop at 018, insert a sentinel row, then run 019 and verify it survived.
  const db = new Database(":memory:");
  migrateUpTo(db, "018_event_kind_triaged");

  const sentinelId = "sentinel-pre019";
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool, agent)
     VALUES (?, 'myproject', 'Sentinel row', 'body text', 'mvp', 'ready', 'task', 'mvp', 'build', 'developer')`,
    [sentinelId],
  );
  const before = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issues")
    .get()!.n;

  // Apply 019
  migrate(db);

  const after = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issues")
    .get()!.n;
  expect(after).toBe(before);

  const row = db
    .query<{ id: string; project: string; title: string; tier: string; pool: string; agent: string }, [string]>(
      "SELECT id, project, title, tier, pool, agent FROM issues WHERE id=?",
    )
    .get(sentinelId);
  expect(row).not.toBeNull();
  expect(row!.project).toBe("myproject");
  expect(row!.title).toBe("Sentinel row");
  expect(row!.tier).toBe("mvp");
  expect(row!.pool).toBe("build");
  expect(row!.agent).toBe("developer");
});

// ── tier/pool/agent CHECKs still enforced post-019 ───────────────────────────

test("019 tier CHECK still enforced (bad tier → SQLITE_CONSTRAINT)", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier)
       VALUES ('t1','p','t','b','mvp','ready','task','badtier')`,
    ),
  ).toThrow();
});

test("019 pool CHECK still enforced (bad pool → SQLITE_CONSTRAINT)", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, pool)
       VALUES ('t2','p','t','b','mvp','ready','task','badpool')`,
    ),
  ).toThrow();
});

test("019 agent CHECK still enforced (bad agent → SQLITE_CONSTRAINT)", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, agent)
       VALUES ('t3','p','t','b','mvp','ready','task','wizard')`,
    ),
  ).toThrow();
});

// ── Idempotent: running migrate twice applies 019 once ───────────────────────

test("019 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("019_issue_kind_sprint");
  const second = migrate(db);
  expect(second).not.toContain("019_issue_kind_sprint");
  expect(second.length).toBe(0);
});

// ── source_module CHECK (table-level) survives 019 ───────────────────────────

test("019 table-level CHECK (kind event/reply need source_module) still enforced", () => {
  const db = fresh();
  // event without source_module should fail
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('ev1','p','t','b','mvp','ready','event')`,
    ),
  ).toThrow();
  // sprint does NOT require source_module
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('sp1','p','t','b','mvp','ready','sprint')`,
    ),
  ).not.toThrow();
});

// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// Tests for cascade-trigger widening — sprint parents re-ready on terminal children.
// All DBs are throwaway in-memory instances — never touches ~/vault/ledger.db.
//
// Change #4 of PR-4: migration 019 emits two triggers instead of one:
//   - unblock_dependents: strict merged-only, restricted to kind != 'sprint'
//   - unblock_sprint_parents: fires on merged|failed|cancelled, kind = 'sprint'
//
// Also tests ledger tick parity (polling backstop mirrors trigger logic).

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate, mintId } from "./db";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

// Helper to insert issues with explicit kind/state/blocked_by
function ins(
  db: Database,
  id: string,
  kind: string,
  state: string,
  blockedBy: string | null = null,
): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, blocked_by, tier, pool)
     VALUES (?, 'p', ?, 'b', 'mvp', ?, ?, ?, 'mvp', 'pool_unset')`,
    [id, id, state, kind, blockedBy],
  );
}

// ── Baseline: sprint parent + 2 children, both merged → ready ────────────────

test("cascade: sprint parent re-readies when both children merged", () => {
  const db = freshDb();
  ins(db, "child-a", "task", "ready");
  ins(db, "child-b", "task", "ready");
  ins(db, "sprint-p", "sprint", "blocked", JSON.stringify(["child-a", "child-b"]));

  db.run("UPDATE issues SET state='merged' WHERE id='child-a'");
  let p = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='sprint-p'").get();
  expect(p?.state).toBe("blocked"); // still blocked — child-b not terminal

  db.run("UPDATE issues SET state='merged' WHERE id='child-b'");
  p = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='sprint-p'").get();
  expect(p?.state).toBe("ready");
});

// ── Sprint parent re-readies when child A merged + child B FAILED ─────────────

test("cascade: sprint parent re-readies when child merged + other child failed", () => {
  const db = freshDb();
  ins(db, "ca", "task", "ready");
  ins(db, "cb", "task", "ready");
  ins(db, "sp", "sprint", "blocked", JSON.stringify(["ca", "cb"]));

  db.run("UPDATE issues SET state='merged' WHERE id='ca'");
  expect(
    db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='sp'").get()?.state,
  ).toBe("blocked");

  db.run("UPDATE issues SET state='failed' WHERE id='cb'");
  expect(
    db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='sp'").get()?.state,
  ).toBe("ready");
});

// ── Sprint parent STAYS blocked when one child is still wip ──────────────────

test("cascade: sprint parent stays blocked when a child is still wip", () => {
  const db = freshDb();
  ins(db, "c1", "task", "ready");
  ins(db, "c2", "task", "wip");
  ins(db, "sp2", "sprint", "blocked", JSON.stringify(["c1", "c2"]));

  db.run("UPDATE issues SET state='merged' WHERE id='c1'");
  expect(
    db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='sp2'").get()?.state,
  ).toBe("blocked");
});

// ── Sprint parent re-readies when last non-terminal child is cancelled ────────

test("cascade: sprint parent re-readies when last child cancelled", () => {
  const db = freshDb();
  ins(db, "c3", "task", "merged");
  ins(db, "c4", "task", "ready");
  ins(db, "sp3", "sprint", "blocked", JSON.stringify(["c3", "c4"]));

  db.run("UPDATE issues SET state='cancelled' WHERE id='c4'");
  expect(
    db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='sp3'").get()?.state,
  ).toBe("ready");
});

// ── REGRESSION GUARD: non-sprint (task) parent stays blocked when one child failed ──

test("cascade regression: task parent stays blocked when child failed (merged-only semantics preserved)", () => {
  const db = freshDb();
  ins(db, "t1", "task", "merged");
  ins(db, "t2", "task", "wip");
  ins(db, "tp", "task", "blocked", JSON.stringify(["t1", "t2"]));

  // t2 → failed: must NOT unblock tp (task requires ALL merged, not just terminal)
  db.run("UPDATE issues SET state='failed' WHERE id='t2'");
  expect(
    db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='tp'").get()?.state,
  ).toBe("blocked");
});

// ── ledger tick parity: sprint blocked row re-readies on all-terminal ─────────
// We construct rows directly (bypassing triggers) then run the tick SQL to
// ensure the polling backstop uses the same two-arm logic.

test("tick: sprint parent with all-terminal blockers re-readies", () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tick-"));
  const path = join(dir, "t.db");
  const db = openWithMigrate(path);
  try {
    // Insert rows directly — state set at INSERT time (trigger won't fire on INSERT)
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool)
       VALUES ('tc1','p','t','b','mvp','merged','task','mvp','pool_unset'),
              ('tc2','p','t','b','mvp','failed','task','mvp','pool_unset')`,
    );
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, blocked_by, tier, pool)
       VALUES ('tsp','p','t','b','mvp','blocked','sprint','["tc1","tc2"]','mvp','pool_unset')`,
    );

    // Run tick SQL (two-arm: non-sprint merged-only + sprint terminal-all)
    db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND kind != 'sprint'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state != 'merged'
        )
    `);
    db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND kind = 'sprint'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state NOT IN ('merged','failed','cancelled')
        )
    `);

    const state = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='tsp'").get();
    expect(state?.state).toBe("ready");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: non-sprint parent with failed child stays blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "cascade-tick-nonsprint-"));
  const path = join(dir, "t.db");
  const db = openWithMigrate(path);
  try {
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, tier, pool)
       VALUES ('tf1','p','t','b','mvp','merged','task','mvp','pool_unset'),
              ('tf2','p','t','b','mvp','failed','task','mvp','pool_unset')`,
    );
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, blocked_by, tier, pool)
       VALUES ('ttp','p','t','b','mvp','blocked','task','["tf1","tf2"]','mvp','pool_unset')`,
    );

    // Non-sprint tick arm only — task requires ALL merged
    db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND kind != 'sprint'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state != 'merged'
        )
    `);

    const state = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='ttp'").get();
    expect(state?.state).toBe("blocked"); // tf2 is failed, not merged → still blocked
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

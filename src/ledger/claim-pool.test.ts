// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// Tests for PR-3: pool-aware dispatch (pool column replaces type column in claim filter)
// TDD — written before implementation.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate, mintId } from "./db";
import { claimOnce, buildClaimSQL } from "./claim";
import { SORT_KEY_SQL } from "./tier-pool-sort";

function freshDb(): { path: string; db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claim-pool-test-"));
  const path = join(dir, "t.db");
  const db = openWithMigrate(path);
  return {
    path,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertReady(
  db: Database,
  title: string,
  tier: string,
  pool: string,
  kind = "task",
): string {
  const id = mintId(db, title);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES (?, 'arc-agents', ?, '', '', 'mvp', 'ready', ?, ?, ?)`,
    [id, title, kind, tier, pool],
  );
  return id;
}

// 1. claim --pool: claimOnce with pool filter claims only interactive rows
test("claimOnce(db, w, 'interactive') claims interactive row, skips higher-sort non-interactive", () => {
  const { db, cleanup } = freshDb();
  try {
    // prod/explore outranks mvp/interactive on tier, but pool filter restricts to interactive
    insertReady(db, "high-tier-non-interactive", "prod", "explore");
    const interactive = insertReady(db, "mvp-interactive", "mvp", "interactive");

    const row = claimOnce(db, "w-fast", "interactive");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(interactive);

    // prod/explore row must remain unclaimed
    const st = db.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get("high-tier-non-interactive") ??
      db.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get(row!.id === interactive ? "high-tier-non-interactive" : "mvp-interactive");
    const nonInteractiveRow = db
      .query<{ state: string; id: string }, []>("SELECT state, id FROM issues WHERE pool != 'interactive'")
      .get();
    expect(nonInteractiveRow?.state).toBe("ready");
  } finally {
    cleanup();
  }
});

// 1b. claimOnce with no filter claims highest-sort row regardless of pool
test("claimOnce(db, w) — no filter — claims highest-sort row regardless of pool", () => {
  const { db, cleanup } = freshDb();
  try {
    const interactive = insertReady(db, "mvp-interactive", "mvp", "interactive");
    insertReady(db, "mvp-explore", "mvp", "explore");
    // prod/interactive is highest priority
    const prod = insertReady(db, "prod-interactive", "prod", "interactive");

    const row = claimOnce(db, "w-any");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(prod); // prod ranks above mvp
    // mvp-interactive was not claimed
    expect(interactive).toBeTruthy(); // suppress lint; used as identity check
  } finally {
    cleanup();
  }
});

// 1c. claimOnce with pool filter returns null when no matching pool row exists
test("claimOnce(db, w, 'interactive') returns null when no interactive ready row exists", () => {
  const { db, cleanup } = freshDb();
  try {
    insertReady(db, "explore-task", "mvp", "explore");
    insertReady(db, "build-task", "trust", "build");

    const row = claimOnce(db, "w-fast", "interactive");
    expect(row).toBeNull();
  } finally {
    cleanup();
  }
});

// 2. buildClaimSQL pool filter uses AND pool=?2
test("buildClaimSQL(true) SQL fragment keys on pool column, not type column", () => {
  const sql = buildClaimSQL(true);
  expect(sql).toContain("AND pool=?2");
  expect(sql).not.toContain("AND type=?2");
});

// 2b. buildClaimSQL(false) does not contain pool filter
test("buildClaimSQL(false) SQL has no pool filter clause", () => {
  const sql = buildClaimSQL(false);
  expect(sql).not.toContain("AND pool=?2");
  expect(sql).not.toContain("AND type=?2");
  // but must still be a valid UPDATE...RETURNING
  expect(sql).toContain("UPDATE issues");
  expect(sql).toContain("RETURNING id");
});

// 2c. SORT_KEY_SQL sanity — still present in claim SQL
test("buildClaimSQL uses SORT_KEY_SQL ordering", () => {
  const sql = buildClaimSQL(false);
  expect(sql).toContain(SORT_KEY_SQL.trim().split("\n")[0]!.trim());
});

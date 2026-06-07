// Tests for the single-sourced atomic claim (ADR 0001 §"Consequences",
// G-0002). claimOnce + CLAIM_SQL are imported by both bin/ledger.ts and
// indirectly by bin/worker-shell.sh (via `ledger print-claim-sql`).

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate, mintId } from "./db";
import { CLAIM_SQL, claimOnce, buildClaimSQL } from "./claim";
import { SORT_KEY_SQL } from "./tier-pool-sort";

function freshDb(): { path: string; db: Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claim-test-"));
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
): string {
  const id = mintId(db, title);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES (?, 'arc-agents', ?, '', '', 'mvp', 'ready', 'task', ?, ?)`,
    [id, title, tier, pool],
  );
  return id;
}

test("CLAIM_SQL contains the canonical UPDATE...RETURNING shape with SORT_KEY_SQL", () => {
  // Guard against drift: the single SQL transition is the whole point of
  // G-0002. If the constant ever stops being an UPDATE...RETURNING that
  // orders by the ADR 0005 sort key, the atomic-claim guarantee is gone.
  expect(CLAIM_SQL).toContain("UPDATE issues");
  expect(CLAIM_SQL).toContain("RETURNING id");
  expect(CLAIM_SQL).toContain("state='claimed'");
  expect(CLAIM_SQL).toContain(SORT_KEY_SQL.trim().split("\n")[0]!.trim());
});

test("claimOnce picks the highest-priority ready row (prod/interactive over mvp/pool_unset)", () => {
  const { db, cleanup } = freshDb();
  try {
    insertReady(db, "low-priority", "mvp", "pool_unset");
    const winner = insertReady(db, "high-priority", "prod", "interactive");
    insertReady(db, "mid", "tier_unset", "pool_unset");

    const row = claimOnce(db, "w-test");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(winner);

    const state = db
      .query<{ state: string; claimed_by: string }, [string]>(
        "SELECT state, claimed_by FROM issues WHERE id=?",
      )
      .get(winner);
    expect(state?.state).toBe("claimed");
    expect(state?.claimed_by).toBe("w-test");
  } finally {
    cleanup();
  }
});

test("claimOnce returns null when no ready rows exist", () => {
  const { db, cleanup } = freshDb();
  try {
    const row = claimOnce(db, "w-empty");
    expect(row).toBeNull();
  } finally {
    cleanup();
  }
});

test("claimOnce returns null when ready rows are all wrong kind", () => {
  const { db, cleanup } = freshDb();
  try {
    // 'prd' kind is not in the ('task','event') allowlist
    const id = mintId(db, "prd-row");
    db.run(
      `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
       VALUES (?, 'arc-agents', 'prd-row', '', '', 'mvp', 'ready', 'prd', 'mvp', 'pool_unset')`,
      [id],
    );
    expect(claimOnce(db, "w-none")).toBeNull();
  } finally {
    cleanup();
  }
});

test("claimOnce with poolFilter restricts to a single pool (fast-pass pool)", () => {
  const { db, cleanup } = freshDb();
  try {
    // build/mvp row outranks the interactive row on tier. But with
    // poolFilter='interactive' the build row must be ignored.
    insertReadyType(db, "build-row", "mvp", "mvp", "build");
    const interactive = insertReadyType(db, "interactive-row", "mvp", "tier_unset", "interactive");

    const row = claimOnce(db, "w-fast", "interactive");
    expect(row?.id).toBe(interactive);
  } finally {
    cleanup();
  }
});

function insertReadyType(
  db: Database,
  title: string,
  type: string,
  tier: string,
  pool: string,
): string {
  const id = mintId(db, title);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES (?, 'arc-agents', ?, '', '', ?, 'ready', 'task', ?, ?)`,
    [id, title, type, tier, pool],
  );
  return id;
}

// ── Change 3: sprint is claimable, prd is not ────────────────────────────────

test("claimOnce claims a kind='sprint' ready row", () => {
  const { db, cleanup } = freshDb();
  try {
    const id = mintId(db, "sprint-row");
    db.run(
      `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
       VALUES (?, 'arc-agents', 'sprint-row', '', '', 'mvp', 'ready', 'sprint', 'mvp', 'pool_unset')`,
      [id],
    );
    const row = claimOnce(db, "w-sprint");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
  } finally {
    cleanup();
  }
});

test("claimOnce does NOT claim a kind='prd' ready row", () => {
  const { db, cleanup } = freshDb();
  try {
    const id = mintId(db, "prd-row-2");
    db.run(
      `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
       VALUES (?, 'arc-agents', 'prd-row-2', '', '', 'mvp', 'ready', 'prd', 'mvp', 'pool_unset')`,
      [id],
    );
    const row = claimOnce(db, "w-prd");
    expect(row).toBeNull();
  } finally {
    cleanup();
  }
});

test("CLAIMABLE_KINDS_SQL contains sprint for claim SQL inclusion", () => {
  expect(CLAIM_SQL).toContain("'sprint'");
});

// ── claimOnce also returns `project` so the worker bootstrap can route
// the worktree to the right physical repo. The row's `project` field is a
// LOGICAL name (e.g. `starlight`), not a path; bin/worker-shell.sh looks it
// up via `project_repo_path` to find the actual git dir (e.g. expert-horde).
// Before this, every worker landed in ~/worktrees/arc-agents-<id> regardless
// of the row's project, leaving the worker with an empty checkout of the
// dispatcher's repo (the originating bug: improve-architecture-worker-shell-sh-wt-).
test("claimOnce returns the row's project alongside id", () => {
  const { db, cleanup } = freshDb();
  try {
    const id = insertReady(db, "starlight-row", "mvp", "pool_unset");
    // insertReady hardcodes 'arc-agents' — override project for this test.
    db.run(`UPDATE issues SET project='starlight' WHERE id=?`, [id]);

    const row = claimOnce(db, "w-proj");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.project).toBe("starlight");
  } finally {
    cleanup();
  }
});

test("claimOnce RETURNING clause includes both id and project columns", () => {
  // The SQL contract: the bash bootstrap parses `claimed` from the JSON
  // output and the worker-shell `project_repo_path` lookup needs `project`.
  // If either column drops out of RETURNING, downstream consumers silently
  // receive undefined — guard the literal here.
  expect(CLAIM_SQL).toContain("RETURNING id, project");
});

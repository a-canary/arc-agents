// Reaper test: spin up a real throwaway git repo + real worktree, then verify
// reapWorktrees() removes the worktree dir, deletes the branch, nulls the
// ledger columns, and logs a kind='note' agent='worktree-reaper' event.
//
// We use a real git repo (not mocked) because the reaper's whole job is to
// shell out to git correctly — a mock would prove nothing.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrate";
import { reapWorktrees, backstopPurgeWorktrees } from "./worktree-reaper";

let workDir: string;
let repoDir: string;
let worktreeDir: string;
const BRANCH = "reaper-test-branch";

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

function setupDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function insertMergedIssue(db: Database, id: string, wt: string | null, br: string | null) {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch)
     VALUES (?, 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?)`,
    [id, wt, br],
  );
}

function insertIssue(db: Database, id: string, state: string, wt: string | null, br: string | null) {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch)
     VALUES (?, 'p', 't', 'b', 'mvp', ?, 'task', ?, ?)`,
    [id, state, wt, br],
  );
}

// Add a commit on the worktree's checked-out branch so it is "ahead of main".
function commitInWorktree(wtDir: string, file: string, body: string) {
  writeFileSync(join(wtDir, file), body);
  const add = git(wtDir, ["add", file]);
  if (!add.ok) throw new Error(`worktree add failed: ${add.out}`);
  const ci = git(wtDir, ["commit", "-q", "-m", `wt: ${file}`]);
  if (!ci.ok) throw new Error(`worktree commit failed: ${ci.out}`);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-reaper-test-"));
  repoDir = join(workDir, "repo");
  worktreeDir = join(workDir, "wt");

  // Init a real git repo with one commit so HEAD exists.
  spawnSync("git", ["init", "-q", "-b", "main", repoDir], { encoding: "utf8" });
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "test"]);
  writeFileSync(join(repoDir, "README"), "seed\n");
  git(repoDir, ["add", "README"]);
  git(repoDir, ["commit", "-q", "-m", "seed"]);

  // Make a real worktree on a new branch.
  const wt = git(repoDir, ["worktree", "add", "-q", worktreeDir, "-b", BRANCH]);
  if (!wt.ok) throw new Error(`worktree add failed: ${wt.out}`);
});

afterEach(() => {
  // Best-effort cleanup — reaper should already have removed it, but in case
  // a test fails partway we don't want to leak temp dirs.
  rmSync(workDir, { recursive: true, force: true });
});

test("removes the worktree, deletes the branch, nulls the row, logs the event", () => {
  const db = setupDb();
  insertMergedIssue(db, "iss-1", worktreeDir, BRANCH);

  expect(existsSync(worktreeDir)).toBe(true);
  expect(git(repoDir, ["branch", "--list", BRANCH]).out).toContain(BRANCH);

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.issue_id).toBe("iss-1");
  expect(reaped[0]!.outcome).toBe("removed");

  // Worktree dir gone.
  expect(existsSync(worktreeDir)).toBe(false);
  // Branch gone from parent repo.
  expect(git(repoDir, ["branch", "--list", BRANCH]).out).toBe("");
  // Ledger columns nulled.
  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-1'",
    )
    .get();
  expect(row?.worktree_path).toBeNull();
  expect(row?.branch).toBeNull();
  // Event logged.
  const ev = db
    .query<{ agent: string; payload_md: string }, []>(
      "SELECT agent, payload_md FROM issue_events WHERE issue_id='iss-1' AND kind='note'",
    )
    .get();
  expect(ev?.agent).toBe("worktree-reaper");
  expect(ev?.payload_md).toContain("worktree-reaped");
  expect(ev?.payload_md).toContain('"outcome":"removed"');
});

test("missing worktree path: clears the row, logs outcome=missing, no git error", () => {
  const db = setupDb();
  const gonePath = join(workDir, "never-existed");
  insertMergedIssue(db, "iss-missing", gonePath, "ghost-branch");

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("missing");

  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-missing'",
    )
    .get();
  expect(row?.worktree_path).toBeNull();
  expect(row?.branch).toBeNull();

  const ev = db
    .query<{ payload_md: string }, []>(
      "SELECT payload_md FROM issue_events WHERE issue_id='iss-missing' AND kind='note'",
    )
    .get();
  expect(ev?.payload_md).toContain('"outcome":"missing"');
});

test("skips non-merged issues even with a worktree_path set", () => {
  const db = setupDb();
  // Insert a 'wip' issue pointing at the live worktree.
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch)
     VALUES ('iss-wip', 'p', 't', 'b', 'mvp', 'wip', 'task', ?, ?)`,
    [worktreeDir, BRANCH],
  );

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(0);
  // Worktree still there, row unchanged.
  expect(existsSync(worktreeDir)).toBe(true);
  const row = db
    .query<{ worktree_path: string | null; state: string }, []>(
      "SELECT worktree_path, state FROM issues WHERE id='iss-wip'",
    )
    .get();
  expect(row?.worktree_path).toBe(worktreeDir);
  expect(row?.state).toBe("wip");
});

test("no-parent-repo: existing dir that isn't a git worktree leaves the row alone", () => {
  const db = setupDb();
  // A plain directory that exists but is not a git worktree.
  const plainDir = join(workDir, "plain");
  spawnSync("mkdir", [plainDir]);
  insertMergedIssue(db, "iss-plain", plainDir, "phantom");

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("no-parent-repo");

  // Row NOT touched — leak-detection signal for a future handler.
  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-plain'",
    )
    .get();
  expect(row?.worktree_path).toBe(plainDir);
  expect(row?.branch).toBe("phantom");
});

test("idempotent: second call is a no-op once the row is cleared", () => {
  const db = setupDb();
  insertMergedIssue(db, "iss-twice", worktreeDir, BRANCH);

  const first = reapWorktrees(db);
  expect(first.length).toBe(1);
  expect(first[0]!.outcome).toBe("removed");

  const second = reapWorktrees(db);
  expect(second.length).toBe(0);
});

// --- Trigger (b): prune-after-triage-processes-a-failed-task ---
// A failed/cancelled row whose worktree carries NO commits ahead of main is
// scratch — nothing to salvage — so the reaper removes it. A failed/cancelled
// row WITH commits is preserved (the human may want to salvage). blocked rows
// stay excluded entirely (decomposition parents need their worktree).

test("(b) reaps a FAILED row whose worktree has no commits ahead of main", () => {
  const db = setupDb();
  insertIssue(db, "iss-fail-clean", "failed", worktreeDir, BRANCH);
  // Worktree is fresh off main → 0 commits ahead.

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.issue_id).toBe("iss-fail-clean");
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
  expect(git(repoDir, ["branch", "--list", BRANCH]).out).toBe("");

  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-fail-clean'",
    )
    .get();
  expect(row?.worktree_path).toBeNull();
  expect(row?.branch).toBeNull();
});

test("(b) PRESERVES a FAILED row whose worktree has commits ahead of main", () => {
  const db = setupDb();
  insertIssue(db, "iss-fail-work", "failed", worktreeDir, BRANCH);
  commitInWorktree(worktreeDir, "salvage.txt", "unmerged work the human may want\n");

  const reaped = reapWorktrees(db);

  // Reported as preserved, NOT removed — and the dir + row are untouched.
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.issue_id).toBe("iss-fail-work");
  expect(reaped[0]!.outcome).toBe("has-commits");
  expect(existsSync(worktreeDir)).toBe(true);

  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-fail-work'",
    )
    .get();
  expect(row?.worktree_path).toBe(worktreeDir);
  expect(row?.branch).toBe(BRANCH);
});

test("(b) reaps a CANCELLED row whose worktree has no commits ahead of main", () => {
  const db = setupDb();
  insertIssue(db, "iss-cancel-clean", "cancelled", worktreeDir, BRANCH);

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

test("(b) still SKIPS blocked rows entirely (decomposition parents keep their worktree)", () => {
  const db = setupDb();
  insertIssue(db, "iss-blocked", "blocked", worktreeDir, BRANCH);

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(0);
  expect(existsSync(worktreeDir)).toBe(true);
  const row = db
    .query<{ worktree_path: string | null; state: string }, []>(
      "SELECT worktree_path, state FROM issues WHERE id='iss-blocked'",
    )
    .get();
  expect(row?.worktree_path).toBe(worktreeDir);
  expect(row?.state).toBe("blocked");
});

test("(b) still SKIPS ready/wip rows even with a worktree_path set", () => {
  const db = setupDb();
  insertIssue(db, "iss-ready", "ready", worktreeDir, BRANCH);
  const reaped = reapWorktrees(db);
  expect(reaped.length).toBe(0);
  expect(existsSync(worktreeDir)).toBe(true);
});

// --- Trigger (c): 7-day backstop purge (disk-scan) ---
// The row-driven reaper only sees worktrees still recorded on a ledger row.
// The pre-startup sweep cancelled/deleted hundreds of rows, leaving on-disk
// worktrees with NO live row — unreachable by reapWorktrees(). The backstop
// disk-scans a worktrees root and removes ONLY dirs that are safe to remove:
//   - branch fully merged to main (0 commits ahead) → pure scratch, remove
//     regardless of age;
//   - OR aged past maxAgeSec AND no live ledger row references it AND it has
//     no unmerged commits.
// It NEVER removes a dir carrying unmerged commits (honor "delete nothing"),
// and NEVER removes a dir a live ledger row still references (let the
// row-driven reaper own those).

// Build a sibling worktree under a scanned root. Returns its path.
function addWorktreeUnder(root: string, name: string, branch: string): string {
  const dir = join(root, name);
  const r = git(repoDir, ["worktree", "add", "-q", dir, "-b", branch]);
  if (!r.ok) throw new Error(`worktree add ${name} failed: ${r.out}`);
  return dir;
}

test("(c) backstop removes an aged, no-row, no-commits worktree", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  const dir = addWorktreeUnder(root, "orphan-clean", "orphan-clean-br");

  // No ledger row references `dir`. Force it "aged" via now far in the future.
  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
  });

  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("removed");
  expect(existsSync(dir)).toBe(false);
});

test("(c) backstop PRESERVES an aged, no-row worktree that has unmerged commits", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  const dir = addWorktreeUnder(root, "orphan-work", "orphan-work-br");
  commitInWorktree(dir, "precious.txt", "unmerged salvageable work\n");

  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
  });

  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("kept-has-commits");
  expect(existsSync(dir)).toBe(true);
});

test("(c) backstop KEEPS a worktree a live ledger row still references", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  const dir = addWorktreeUnder(root, "tracked", "tracked-br");
  // A live (wip) row owns this dir → backstop must not touch it.
  insertIssue(db, "iss-live", "wip", dir, "tracked-br");

  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
  });

  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("kept-live-row");
  expect(existsSync(dir)).toBe(true);
});

test("(c) backstop KEEPS a young, no-row, no-commits worktree (not yet aged out)", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  const dir = addWorktreeUnder(root, "fresh", "fresh-br");

  // now == real now, dir just created → under the 7d age gate.
  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000),
  });

  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("kept-too-young");
  expect(existsSync(dir)).toBe(true);
});

test("(c) backstop removes a fully-merged worktree regardless of age", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  const dir = addWorktreeUnder(root, "merged-young", "merged-young-br");
  // Commit on the branch, then merge it into main → 0 commits ahead of main.
  commitInWorktree(dir, "feature.txt", "shipped\n");
  const merge = git(repoDir, ["merge", "--no-ff", "-q", "-m", "merge feature", "merged-young-br"]);
  if (!merge.ok) throw new Error(`merge failed: ${merge.out}`);

  // now == real now → young, but merged → removable anyway.
  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000),
  });

  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("removed");
  expect(existsSync(dir)).toBe(false);
});

test("(c) backstop is a no-op on an empty/absent root", () => {
  const db = setupDb();
  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: join(workDir, "does-not-exist"),
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
  });
  expect(res.length).toBe(0);
});

// --- Live-worker guard: race between merge and reap ---
// Reported in starlight-e13-... (2026-06-04): row flipped to merged while a
// worker session was still alive (or had a still-running bash subprocess with
// the worktree as its CWD). reapWorktrees() fired 1s after the merge and
// yanked the worktree dir, breaking the worker's next bash command
// ("Working directory does not exist"). The guard takes a set of live tmux
// worker-session names; rows whose claimed_by is in the set are skipped with
// outcome=worker-alive (deferred to the next tick once the session is gone).

test("live-worker guard: skips a merged row whose claimed_by is in the live set", () => {
  const db = setupDb();
  // Row claims to be from a still-alive worker session.
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-live-merge', 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?, ?)`,
    [worktreeDir, BRANCH, "arc-worker-a-abc123"],
  );

  const live = new Set(["arc-worker-a-abc123"]);
  const reaped = reapWorktrees(db, live);

  // Reported as deferred, NOT removed.
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.issue_id).toBe("iss-live-merge");
  expect(reaped[0]!.outcome).toBe("worker-alive");
  expect(reaped[0]!.detail).toContain("arc-worker-a-abc123");

  // Worktree + row untouched — the worker can still use it as its CWD.
  expect(existsSync(worktreeDir)).toBe(true);
  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-live-merge'",
    )
    .get();
  expect(row?.worktree_path).toBe(worktreeDir);
  expect(row?.branch).toBe(BRANCH);

  // No worktree-reaped event was logged for the deferred row.
  const ev = db
    .query<{ payload_md: string }, []>(
      "SELECT payload_md FROM issue_events WHERE issue_id='iss-live-merge' AND agent='worktree-reaper'",
    )
    .get();
  expect(ev ?? null).toBeNull();
});

test("live-worker guard: same row, no live set → reaps normally (regression: guard is opt-in)", () => {
  const db = setupDb();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-no-guard', 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?, ?)`,
    [worktreeDir, BRANCH, "arc-worker-a-abc123"],
  );

  // No liveWorkerNames passed → guard is a no-op, the row reaps as before.
  const reaped = reapWorktrees(db);
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

test("live-worker guard: same row, live set without this session → reaps normally", () => {
  const db = setupDb();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-other-alive', 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?, ?)`,
    [worktreeDir, BRANCH, "arc-worker-a-abc123"],
  );

  // Live set contains a DIFFERENT worker — this one is dead, so reap proceeds.
  const live = new Set(["arc-worker-a-zzz999"]);
  const reaped = reapWorktrees(db, live);
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

test("live-worker guard: live set is empty → reaps normally", () => {
  const db = setupDb();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-empty-set', 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?, ?)`,
    [worktreeDir, BRANCH, "arc-worker-a-abc123"],
  );

  const reaped = reapWorktrees(db, new Set());
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

test("live-worker guard: second call after session is gone → reaps the deferred row", () => {
  const db = setupDb();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-defer-then-reap', 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?, ?)`,
    [worktreeDir, BRANCH, "arc-worker-a-abc123"],
  );

  // Tick 1: worker alive → deferred.
  const first = reapWorktrees(db, new Set(["arc-worker-a-abc123"]));
  expect(first.length).toBe(1);
  expect(first[0]!.outcome).toBe("worker-alive");
  expect(existsSync(worktreeDir)).toBe(true);

  // Tick 2: worker gone → reap fires.
  const second = reapWorktrees(db, new Set());
  expect(second.length).toBe(1);
  expect(second[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

test("live-worker guard: applies to FAILED + CANCELLED rows too, not just merged", () => {
  const db = setupDb();
  // One failed, one cancelled, both with worktrees clean of unmerged commits.
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-fail-live', 'p', 't', 'b', 'mvp', 'failed', 'task', ?, ?, ?)`,
    [worktreeDir, BRANCH, "arc-worker-a-abc123"],
  );
  // Make a sibling worktree for the cancelled row.
  const wt2 = join(workDir, "wt2");
  const r = git(repoDir, ["worktree", "add", "-q", wt2, "-b", "reaper-test-branch-2"]);
  if (!r.ok) throw new Error(`worktree add wt2 failed: ${r.out}`);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-cancel-live', 'p', 't', 'b', 'mvp', 'cancelled', 'task', ?, ?, ?)`,
    [wt2, "reaper-test-branch-2", "arc-worker-a-xyz789"],
  );

  // Both workers alive → both deferred.
  const live = new Set(["arc-worker-a-abc123", "arc-worker-a-xyz789"]);
  const reaped = reapWorktrees(db, live);

  expect(reaped.length).toBe(2);
  const byId = new Map(reaped.map((r) => [r.issue_id, r]));
  expect(byId.get("iss-fail-live")?.outcome).toBe("worker-alive");
  expect(byId.get("iss-cancel-live")?.outcome).toBe("worker-alive");
  expect(existsSync(worktreeDir)).toBe(true);
  expect(existsSync(wt2)).toBe(true);
});

test("live-worker guard: row with claimed_by=NULL is NOT skipped (no live worker to protect)", () => {
  const db = setupDb();
  // Merged row with NO claimed_by — the guard should not apply.
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, worktree_path, branch, claimed_by)
     VALUES ('iss-no-claim', 'p', 't', 'b', 'mvp', 'merged', 'task', ?, ?, NULL)`,
    [worktreeDir, BRANCH],
  );

  const live = new Set(["arc-worker-a-abc123"]);
  const reaped = reapWorktrees(db, live);

  // Despite the live set being non-empty, this row is reapable because no
  // worker currently owns it. (The set protects OWNED worktrees, not all.)
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

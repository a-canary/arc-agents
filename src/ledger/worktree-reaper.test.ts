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
import { reapWorktrees } from "./worktree-reaper";

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

test("main-worktree guard: skips repo root, clears row, never shells worktree remove", () => {
  const db = setupDb();
  // Point a merged row at the *main* worktree (the repo dir itself), which is
  // exactly the operational bug that caused the spawn-storm: git worktree
  // remove on the main worktree always fails, so the row sat unreaped forever.
  insertMergedIssue(db, "iss-main", repoDir, "main");

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("skipped-main-worktree");

  // Row cleared so the reaper never visits it again.
  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-main'",
    )
    .get();
  expect(row?.worktree_path).toBeNull();
  expect(row?.branch).toBeNull();

  // Repo dir + branch still exist — we did NOT shell `git worktree remove`.
  expect(existsSync(repoDir)).toBe(true);
  expect(git(repoDir, ["branch", "--list", "main"]).out).toContain("main");

  const ev = db
    .query<{ payload_md: string }, []>(
      "SELECT payload_md FROM issue_events WHERE issue_id='iss-main' AND kind='note'",
    )
    .get();
  expect(ev?.payload_md).toContain('"outcome":"skipped-main-worktree"');
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

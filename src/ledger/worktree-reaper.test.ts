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

// --- main-working-tree guard ---
// Regression for the 2026-06-11 factory hot loop: 4 merged rows had a
// worktree_path pointing at a repo's MAIN checkout (not a linked worktree).
// `git worktree remove` can never delete a main tree, so the reaper failed
// every tick and never nulled the row — an infinite loop. The guard must skip
// the remove, null the columns (so the row is never revisited), and leave the
// main checkout AND its branch fully intact.

test("main-working-tree: skips removal, nulls the row, never touches the main checkout", () => {
  const db = setupDb();
  // repoDir IS the main working tree. The current branch there is 'main'.
  insertMergedIssue(db, "iss-main", repoDir, "main");

  // Capture the main checkout's HEAD so we can prove it's untouched.
  const headBefore = git(repoDir, ["rev-parse", "HEAD"]).out;

  const reaped = reapWorktrees(db);

  expect(reaped.length).toBe(1);
  expect(reaped[0]!.issue_id).toBe("iss-main");
  expect(reaped[0]!.outcome).toBe("main-working-tree");

  // Main checkout dir still exists and HEAD is unchanged.
  expect(existsSync(repoDir)).toBe(true);
  expect(git(repoDir, ["rev-parse", "HEAD"]).out).toBe(headBefore);
  // The 'main' branch was NOT deleted.
  expect(git(repoDir, ["branch", "--list", "main"]).out).toContain("main");

  // Row columns nulled so the row is never revisited → loop broken.
  const row = db
    .query<{ worktree_path: string | null; branch: string | null }, []>(
      "SELECT worktree_path, branch FROM issues WHERE id='iss-main'",
    )
    .get();
  expect(row?.worktree_path).toBeNull();
  expect(row?.branch).toBeNull();

  // Event logged with the new outcome.
  const ev = db
    .query<{ payload_md: string }, []>(
      "SELECT payload_md FROM issue_events WHERE issue_id='iss-main' AND kind='note'",
    )
    .get();
  expect(ev?.payload_md).toContain('"outcome":"main-working-tree"');

  // And it's a one-shot: the now-nulled row is not revisited.
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

// --- Upstream-aware unpushed count ---
// Regression for improve-architecture-worktree-reaper-unp: the commit guard
// counted `main..HEAD`, so a branch with an in-sync upstream (e.g. a deploy
// branch == origin/deploy/...) was reported as having N "unpushed" commits
// that were fully pushed — safe work mislabeled at-risk. With an upstream,
// only commits NOT on the upstream are at risk; `main..HEAD` is the fallback
// for upstream-less branches.

function addBareOrigin(): string {
  const origin = join(workDir, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", origin], { encoding: "utf8" });
  git(repoDir, ["remote", "add", "origin", origin]);
  return origin;
}

test("(b) reaps a FAILED row whose commits are all pushed to an in-sync upstream (even if ahead of main)", () => {
  const db = setupDb();
  addBareOrigin();
  insertIssue(db, "iss-fail-pushed", "failed", worktreeDir, BRANCH);
  commitInWorktree(worktreeDir, "pushed.txt", "work that is on origin\n");
  const push = git(worktreeDir, ["push", "-q", "-u", "origin", BRANCH]);
  if (!push.ok) throw new Error(`push failed: ${push.out}`);

  // Ahead of main by 1, but fully pushed → nothing at risk → removable.
  expect(git(worktreeDir, ["rev-list", "--count", "main..HEAD"]).out).toBe("1");

  const reaped = reapWorktrees(db);
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.issue_id).toBe("iss-fail-pushed");
  expect(reaped[0]!.outcome).toBe("removed");
  expect(existsSync(worktreeDir)).toBe(false);
});

test("(b) PRESERVES a FAILED row with commits ahead of its upstream (unpushed work)", () => {
  const db = setupDb();
  addBareOrigin();
  insertIssue(db, "iss-fail-unpushed", "failed", worktreeDir, BRANCH);
  commitInWorktree(worktreeDir, "a.txt", "first\n");
  const push = git(worktreeDir, ["push", "-q", "-u", "origin", BRANCH]);
  if (!push.ok) throw new Error(`push failed: ${push.out}`);
  commitInWorktree(worktreeDir, "b.txt", "second, unpushed\n");

  const reaped = reapWorktrees(db);
  expect(reaped.length).toBe(1);
  expect(reaped[0]!.outcome).toBe("has-commits");
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

// --- P0b: merged worktree with uncommitted changes must not be force-deleted.
test("reapWorktrees PRESERVES a merged worktree with uncommitted changes (no data loss)", () => {
  const db = setupDb();
  insertMergedIssue(db, "iss-dirty", worktreeDir, BRANCH);
  // Uncommitted edit in the merged worktree — `-f -f` would force-delete it.
  writeFileSync(join(worktreeDir, "scratch.txt"), "unsaved work\n");

  const reaped = reapWorktrees(db);
  const mine = reaped.find((r) => r.issue_id === "iss-dirty");
  expect(mine?.outcome).toBe("dirty-uncommitted");
  expect(existsSync(worktreeDir)).toBe(true);
  // Row left intact so a later clean reap can still find & remove it.
  const row = db
    .query<{ worktree_path: string | null }, [string]>("SELECT worktree_path FROM issues WHERE id=?")
    .get("iss-dirty");
  expect(row?.worktree_path).toBe(worktreeDir);
});

// --- P0a: backstop must reap orphans owned by a DIFFERENT repo than parentRepo.
test("(c) backstop reaps an orphan worktree owned by a different repo than parentRepo", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  // A second, independent repo whose worktree lands under the same root.
  const repo2 = join(workDir, "repo2");
  spawnSync("git", ["init", "-q", "-b", "main", repo2], { encoding: "utf8" });
  git(repo2, ["config", "user.email", "t@e.com"]);
  git(repo2, ["config", "user.name", "t"]);
  writeFileSync(join(repo2, "README"), "seed2\n");
  git(repo2, ["add", "README"]);
  git(repo2, ["commit", "-q", "-m", "seed2"]);
  const dir = join(root, "foreign");
  const r = git(repo2, ["worktree", "add", "-q", dir, "-b", "foreign-br"]);
  if (!r.ok) throw new Error(`foreign wt add failed: ${r.out}`);

  // parentRepo is the FIRST repo; the foreign dir is not its worktree. The old
  // code ran `git -C repoDir worktree remove <foreign>` → fail → never reaped.
  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
  });
  const mine = res.find((x) => x.worktree_path === dir);
  expect(mine?.outcome).toBe("removed");
  expect(existsSync(dir)).toBe(false);
});

// --- P0b: backstop preserves an orphan with uncommitted (0-commit) changes.
test("(c) backstop PRESERVES an aged, no-row orphan that has only uncommitted changes", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  const dir = addWorktreeUnder(root, "orphan-dirty", "orphan-dirty-br");
  writeFileSync(join(dir, "wip.txt"), "uncommitted, untracked\n"); // 0 commits ahead

  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
  });
  const mine = res.find((x) => x.worktree_path === dir);
  expect(mine?.outcome).toBe("kept-has-commits");
  expect(existsSync(dir)).toBe(true);
});

// --- Squash-merge stranded worktrees (Pattern 1 from
// analysis-1783742673-pipeliner-analyse-recent-sessions.md):
// squash-merge produces a NEW main SHA that is NOT an ancestor of the branch
// tip, so unpushedCommits == 1 (no upstream, ahead of main) but the work is
// genuinely in main. The reaper
// must consult `gh pr list --head <branch> --state merged` to distinguish
// "squash-merged (dead)" from "really ahead of main (preserve)".
test("(c) backstop REAPS a squash-merged orphan when gh reports MERGED PR", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  // Give repoDir an origin so parseGithubSlug returns a slug for the stub.
  git(repoDir, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const dir = addWorktreeUnder(root, "squashed", "sq-br");
  // One commit on the branch tip → ahead == 1 (the squash-merge signature).
  commitInWorktree(dir, "feature.txt", "shipped-via-squash\n");

  // Stub gh: only one PR for this branch and it's MERGED.
  const ghRunner = (args: string[]) => {
    if (args.includes("--state") && args.includes("merged")) {
      return { ok: true, out: JSON.stringify([{ state: "MERGED", number: 42 }]) };
    }
    return { ok: true, out: "[]" };
  };

  // now == real now → young, but squash-merged → removable anyway.
  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000),
    ghRunner,
  });
  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("removed");
  expect(existsSync(dir)).toBe(false);
});

test("(c) backstop PRESERVES an ahead-of-main orphan when gh reports NO merged PR", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  git(repoDir, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const dir = addWorktreeUnder(root, "unmerged", "unmerged-br");
  commitInWorktree(dir, "wip.txt", "still-in-progress\n");

  // gh says: no merged PR for this branch. The reaper must NOT touch it.
  const ghRunner = () => ({ ok: true, out: "[]" });

  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
    ghRunner,
  });
  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("kept-has-commits");
  expect(existsSync(dir)).toBe(true);
});

test("(c) backstop PRESERVES an ahead-of-main orphan when gh is unavailable (null → conservative)", () => {
  const db = setupDb();
  const root = join(workDir, "wts");
  spawnSync("mkdir", ["-p", root]);
  git(repoDir, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const dir = addWorktreeUnder(root, "gh-down", "gh-down-br");
  commitInWorktree(dir, "wip.txt", "ambiguous state\n");

  // gh exits non-zero (missing binary, no auth, network error) → runner returns
  // ok=false → ghPrMerged returns null → reaper falls through to keep.
  const ghRunner = () => ({ ok: false, out: "gh: not authenticated" });

  const res = backstopPurgeWorktrees(db, {
    worktreesRoot: root,
    parentRepo: repoDir,
    maxAgeSec: 7 * 86400,
    now: Math.floor(Date.now() / 1000) + 30 * 86400,
    ghRunner,
  });
  const mine = res.find((r) => r.worktree_path === dir);
  expect(mine?.outcome).toBe("kept-has-commits");
  expect(existsSync(dir)).toBe(true);
});

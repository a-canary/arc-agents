// Worktree reaper: removes the git worktree + branch for issues that are done
// with their worktree and have a worktree_path still recorded on the row.
//
// Three triggers (Aaron's reap policy, 2026-05-27):
//   (a) prune-after-merge   — state=merged rows: work is in main, worktree is
//       scratch, always safe to remove.
//   (b) prune-after-triage  — state IN (failed,cancelled) rows: the triage/
//       reconcile flow has finished with them. Remove ONLY if the worktree has
//       zero commits ahead of main (nothing to salvage). A failed/cancelled
//       row WITH commits is PRESERVED (outcome=has-commits) so the human can
//       decide salvage. blocked is still excluded — decomposition parents need
//       their worktree until children resolve.
//   (c) 7-day backstop      — backstopPurgeWorktrees() below: a disk-scan for
//       orphan worktrees that no live row references (the pre-startup sweep
//       nulled/cancelled their rows, so (a)/(b) can never reach them).
//
// Cheap-sweep-on-tick: reapWorktrees() runs as part of factory tick(). The work
// it does is proportional to the number of merged/failed/cancelled-with-worktree
// rows since last sweep, which is ~0 most ticks. After successful reap the
// worktree_path/branch columns are nulled so the row is not visited again.
//
// We can't emit a new event kind without a schema migration (issue_events.kind
// has a CHECK constraint), so reap is logged as kind='note' with an agent tag.
//
// SECURITY:
//   - All git ops use `git -C <path>` to scope to the relevant worktree/repo.
//   - We never invoke a shell; spawnSync with array argv only, so paths with
//     spaces or shell metacharacters can't escape.
//   - `git worktree remove` and `git branch -D` will fail loudly if the path
//     is not actually a worktree managed by git — we treat any failure as a
//     leave-it-alone signal and just log.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type ReapedWorktree = {
  issue_id: string;
  worktree_path: string | null;
  branch: string | null;
  // has-commits: a failed/cancelled row whose worktree has unmerged commits —
  // preserved for human salvage, row untouched.
  // main-working-tree: worktree_path points at a repo's MAIN checkout (not a
  // linked worktree). `git worktree remove` can never delete a main tree, so
  // retrying every tick is a hot loop. We null the columns instead (the work
  // is merged; the path was misrecorded) so the row is never revisited.
  // worker-active: a live tmux session holds a recent .worker-lease heartbeat
  // (≤5 min old). The reaper must not steal a worktree from an active worker.
  outcome:
    | "removed"
    | "missing"
    | "git-remove-failed"
    | "no-parent-repo"
    | "has-commits"
    | "main-working-tree"
    | "worker-active";
  detail?: string;
};

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

// Resolve the parent repo dir (the one git worktree remove must run in) from
// any worktree path. `git -C <wt> rev-parse --git-common-dir` returns the
// common .git dir; its parent is the parent repo. Returns null if the path
// is not part of any git worktree.
function findParentRepo(worktreePath: string): string | null {
  const r = git(worktreePath, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return null;
  const commonDir = r.out;
  // git-common-dir may be relative to cwd or absolute; resolve via realpath.
  const real = spawnSync("realpath", [commonDir], { encoding: "utf8", cwd: worktreePath });
  if (real.status !== 0) return null;
  const abs = real.stdout.trim();
  // Parent repo = dir containing .git (strip trailing `/.git`).
  return abs.endsWith("/.git") ? abs.slice(0, -5) : abs;
}

// True when `path` is the MAIN working tree of its repo (not a linked
// worktree). For a main tree, `--git-dir` and `--git-common-dir` resolve to
// the SAME path; for a linked worktree, --git-dir is `.git/worktrees/<name>`
// while --git-common-dir is the shared `.git`. `git worktree remove` refuses
// to delete a main tree ("'<path>' is a main working tree"), so the reaper
// must never attempt it — detect and skip. Any git failure returns false:
// the caller then falls through to the normal remove path, which fails loudly
// and is logged, rather than silently nulling a row we couldn't classify.
function isMainWorktree(path: string): boolean {
  const gitDir = git(path, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.ok) return false;
  const commonDir = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir.ok) return false;
  return gitDir.out === commonDir.out;
}

// Count commits on the worktree's HEAD that are NOT reachable from main —
// i.e. unmerged work. 0 means the branch is fully merged (or never diverged):
// nothing to salvage. Any git failure (detached, no main, corrupt) is treated
// as "has commits" (return >0) so we err on the side of PRESERVING — we never
// remove a worktree we can't prove is safe.
function commitsAheadOfMain(worktreePath: string): number {
  const r = git(worktreePath, ["rev-list", "--count", "main..HEAD"]);
  if (!r.ok) return 1;
  const n = parseInt(r.out.trim(), 10);
  return Number.isFinite(n) ? n : 1;
}

// True when the worktree has a .worker-lease file updated ≤ 10 min ago.
// Workers write the heartbeat in hooks/session-start.sh; it is the
// cooperative anti-reaper signal. If present and fresh, skip the reap so
// we don't delete a worktree out from under an active tmux session.
// TTL is 10 min to exceed the 5-min factory tick, preventing a race where
// the tick fires just before the lease expires and reaps a live session.
const LEASE_TTL_SEC = 10 * 60;

function hasActiveLease(worktreePath: string): boolean {
  const leaseFile = join(worktreePath, ".worker-lease");
  if (!existsSync(leaseFile)) return false;
  try {
    const mtimeSec = Math.floor(statSync(leaseFile).mtimeMs / 1000);
    const ageSec = Math.floor(Date.now() / 1000) - mtimeSec;
    return ageSec <= LEASE_TTL_SEC;
  } catch {
    return false;
  }
}

// Count commits on main NOT reachable from the worktree's HEAD (`HEAD..main`).
// >0 means main has advanced past HEAD (work integrated/superseded). On any
// git failure return 0 — the caller only treats >0 as a removal fast-path, so
// failing closed here just defers to the age gate (the conservative branch).
function behindMain(worktreePath: string): number {
  const r = git(worktreePath, ["rev-list", "--count", "HEAD..main"]);
  if (!r.ok) return 0;
  const n = parseInt(r.out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function reapWorktrees(db: Db): ReapedWorktree[] {
  // (a) merged + (b) failed/cancelled. blocked stays excluded (decomposition
  // parents). ready/wip/claimed/review are live — never reaped here.
  const rows = db
    .query(
      `SELECT id, state, worktree_path, branch FROM issues
       WHERE state IN ('merged','failed','cancelled') AND worktree_path IS NOT NULL`,
    )
    .all() as { id: string; state: string; worktree_path: string; branch: string | null }[];

  const reaped: ReapedWorktree[] = [];
  for (const row of rows) {
    const wt = row.worktree_path;
    const br = row.branch;

    // Guard: a worker holds a live lease on this worktree — skip.
    if (existsSync(wt) && hasActiveLease(wt)) {
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worktree-reaper', ?)`,
        [row.id, JSON.stringify({ event: "worktree-reaped", outcome: "worker-active", worktree_path: wt, branch: br })],
      );
      reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "worker-active" });
      continue;
    }

    // (b) commit-guard: a failed/cancelled worktree with unmerged commits is
    // preserved for human salvage. merged rows skip this — their work is
    // already in main, so the worktree is scratch regardless of "ahead" count.
    // The guard runs only when the dir still exists (commitsAheadOfMain needs
    // a live worktree); a missing dir falls through to the cleanup below.
    if (row.state !== "merged" && existsSync(wt) && commitsAheadOfMain(wt) > 0) {
      reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "has-commits" });
      continue;
    }

    // Path already gone — just clear the columns so we don't revisit.
    if (!existsSync(wt)) {
      db.run(
        `UPDATE issues SET worktree_path=NULL, branch=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [row.id],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worktree-reaper', ?)`,
        [row.id, JSON.stringify({ event: "worktree-reaped", outcome: "missing", worktree_path: wt, branch: br })],
      );
      reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "missing" });
      continue;
    }

    const parent = findParentRepo(wt);
    if (!parent) {
      // Worktree dir exists but git doesn't recognize it as a worktree — leave
      // alone, don't touch the row. Could be user-owned scratch, manually
      // detached, or git data corruption. Surfaces as a persistent row that
      // future detect-leaks work can handle.
      reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "no-parent-repo" });
      continue;
    }

    // Guard: worktree_path points at a repo's MAIN checkout, not a linked
    // worktree. `git worktree remove` can never delete a main tree, so the
    // unguarded path below would fail every tick and never null the row — a
    // hot loop (observed 2026-06-11: 4 merged rows pinned to main checkouts of
    // llm-judge/discord-bridge/conjecture spun the factory tick forever). The
    // work is merged; the path was misrecorded. Null the columns so the row is
    // never revisited, and log it for leak-detection.
    if (isMainWorktree(wt)) {
      db.run(
        `UPDATE issues SET worktree_path=NULL, branch=NULL, updated_at=strftime('%s','now') WHERE id=?`,
        [row.id],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worktree-reaper', ?)`,
        [
          row.id,
          JSON.stringify({ event: "worktree-reaped", outcome: "main-working-tree", worktree_path: wt, branch: br }),
        ],
      );
      reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "main-working-tree" });
      continue;
    }

    // `-f -f` overrides the claude-agent lock that some worktrees carry.
    const rm = git(parent, ["worktree", "remove", "-f", "-f", wt]);
    if (!rm.ok) {
      reaped.push({
        issue_id: row.id,
        worktree_path: wt,
        branch: br,
        outcome: "git-remove-failed",
        detail: rm.out,
      });
      continue;
    }

    // Best-effort branch delete. Failure (branch already gone, not fully
    // merged, etc.) is fine — branch hygiene is secondary to worktree cleanup.
    if (br) git(parent, ["branch", "-D", br]);

    db.run(
      `UPDATE issues SET worktree_path=NULL, branch=NULL, updated_at=strftime('%s','now') WHERE id=?`,
      [row.id],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worktree-reaper', ?)`,
      [row.id, JSON.stringify({ event: "worktree-reaped", outcome: "removed", worktree_path: wt, branch: br })],
    );
    reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "removed" });
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Trigger (c): 7-day backstop purge (disk-scan).
//
// The row-driven reapWorktrees() can only see worktrees still recorded on a
// ledger row. The 2026-05-27 pre-startup sweep cancelled/deleted ~751 rows,
// orphaning their on-disk worktrees — unreachable by any row query. This
// backstop disk-scans the worktrees root and removes ONLY dirs that are
// provably safe:
//   - branch fully merged to main (0 commits ahead) → pure scratch, removed
//     regardless of age; OR
//   - aged past maxAgeSec AND no live ledger row references it AND 0 commits
//     ahead of main.
// It NEVER removes a dir with unmerged commits (Aaron: "delete nothing" for
// commit-bearing orphans), and NEVER removes a dir a live ledger row still
// references (the row-driven reaper owns those).
//
// SECURITY: same as above — array argv only, `git -C`, no shell. The scan is
// scoped to `worktreesRoot`; we readdir one level and only touch direct
// children that git recognizes as worktrees of `parentRepo`.

export type BackstopOutcome =
  | "removed"
  | "kept-has-commits"
  | "kept-live-row"
  | "kept-too-young"
  | "kept-worker-active"
  | "not-a-worktree";

export type BackstopResult = {
  worktree_path: string;
  outcome: BackstopOutcome;
  detail?: string;
};

export type BackstopOpts = {
  worktreesRoot: string;
  parentRepo: string;
  maxAgeSec: number;
  now?: number; // unix seconds; defaults to wall clock (overridable for tests)
};

export function backstopPurgeWorktrees(db: Db, opts: BackstopOpts): BackstopResult[] {
  const { worktreesRoot, parentRepo, maxAgeSec } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const results: BackstopResult[] = [];

  if (!existsSync(worktreesRoot)) return results;

  // Build the set of worktree paths a live ledger row still references, so we
  // skip them (let reapWorktrees own row-tracked dirs). We include ALL states:
  // a row in any state is a signal the dir is still "owned".
  const tracked = new Set<string>();
  const trackedRows = db
    .query(`SELECT worktree_path FROM issues WHERE worktree_path IS NOT NULL`)
    .all() as { worktree_path: string }[];
  for (const r of trackedRows) tracked.add(r.worktree_path);

  let entries: string[];
  try {
    entries = readdirSync(worktreesRoot);
  } catch {
    return results;
  }

  for (const name of entries) {
    const dir = join(worktreesRoot, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    // Confirm git actually manages this as a worktree before touching it.
    if (!findParentRepo(dir)) {
      results.push({ worktree_path: dir, outcome: "not-a-worktree" });
      continue;
    }

    // A live ledger row owns it — defer to the row-driven reaper.
    if (tracked.has(dir)) {
      results.push({ worktree_path: dir, outcome: "kept-live-row" });
      continue;
    }

    // A live lease (active worker) takes priority over the backstop.
    if (hasActiveLease(dir)) {
      results.push({ worktree_path: dir, outcome: "kept-worker-active" });
      continue;
    }

    // Unmerged commits → never auto-remove (preserve for salvage).
    if (commitsAheadOfMain(dir) > 0) {
      results.push({ worktree_path: dir, outcome: "kept-has-commits" });
      continue;
    }

    // 0 commits ahead is ambiguous, so consult how far main is AHEAD of this
    // worktree's HEAD (`HEAD..main`):
    //   - >0 : main advanced past HEAD → the work was integrated (or the branch
    //          was superseded). Scratch — removable regardless of age.
    //   - ==0: HEAD == main (a pristine fork point that never diverged). Apply
    //          the age gate — only remove once it's older than maxAgeSec, so we
    //          don't yank a worktree a worker just created.
    const behind = behindMain(dir);
    const ageSec = now - Math.floor(st.mtimeMs / 1000);
    if (behind === 0 && ageSec < maxAgeSec) {
      results.push({ worktree_path: dir, outcome: "kept-too-young" });
      continue;
    }

    const rm = git(parentRepo, ["worktree", "remove", "-f", "-f", dir]);
    if (!rm.ok) {
      results.push({ worktree_path: dir, outcome: "kept-too-young", detail: `git-remove-failed: ${rm.out}` });
      continue;
    }
    results.push({ worktree_path: dir, outcome: "removed" });
  }

  return results;
}

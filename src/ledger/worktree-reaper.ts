// Worktree reaper: removes the git worktree + branch for issues that have
// reached state=merged with a worktree_path still recorded on the row.
//
// Scope is intentionally narrow (merged only, not failed/cancelled/blocked):
//   - merged is unambiguously safe — work is in main, worktree is scratch.
//   - failed/cancelled may still hold uncommitted evidence the human wants.
//   - blocked decomposition parents need their worktree until children resolve.
//
// Cheap-sweep-on-tick: this runs as part of factory tick(). The work it does is
// proportional to the number of merged-with-worktree rows since last sweep,
// which is ~0 most ticks. After successful reap the worktree_path/branch
// columns are nulled so the row is not visited again.
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
import { existsSync } from "node:fs";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type ReapedWorktree = {
  issue_id: string;
  worktree_path: string | null;
  branch: string | null;
  outcome: "removed" | "missing" | "git-remove-failed" | "no-parent-repo";
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

export function reapWorktrees(db: Db): ReapedWorktree[] {
  const rows = db
    .query(
      `SELECT id, worktree_path, branch FROM issues
       WHERE state='merged' AND worktree_path IS NOT NULL`,
    )
    .all() as { id: string; worktree_path: string; branch: string | null }[];

  const reaped: ReapedWorktree[] = [];
  for (const row of rows) {
    const wt = row.worktree_path;
    const br = row.branch;

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

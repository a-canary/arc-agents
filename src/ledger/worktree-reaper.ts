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
//
// LIVE-WORKER GUARD: reapWorktrees() takes an optional `liveWorkerNames` set
// and skips any row whose `claimed_by` is in the set. The factory tick()
// builds that set from listWorkers() right before calling the reaper, so a
// worker whose row was just flipped to terminal but whose bash subprocess is
// still alive (race: reapFinished() just sent kill-session, the process
// hasn't torn down yet) does NOT lose its CWD out from under it. The reap
// fires on the next tick, after the session is actually gone.

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
  // worker-alive: a row whose claimed_by tmux session is still listed as live
  // (defensive skip — reaping would yank the CWD out from under a worker that
  // has a still-running bash subprocess; observed in starlight-e13-... where a
  // merged worker was idling and the reap removed its worktree mid-session).
  outcome:
    | "removed"
    | "missing"
    | "git-remove-failed"
    | "no-parent-repo"
    | "has-commits"
    | "worker-alive";
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

export function reapWorktrees(
  db: Db,
  // Optional set of live tmux worker-session names. When provided, the reaper
  // skips rows whose `claimed_by` is in the set — a defensive guard against
  // the race where the worker's bash subprocess is still alive (reapFinished
  // just sent kill-session, but the process hasn't fully torn down yet, or
  // the worker has a long-lived child whose CWD is the reaped worktree).
  // Passing the set is preferred over letting the reaper shell out to tmux:
  //   - the factory already has the set from listWorkers();
  //   - the test harness can pin a deterministic set without tmux at all.
  // `undefined` / `null` / empty set all mean "no live workers known" → the
  // guard is a no-op and the reaper proceeds with the normal policy.
  liveWorkerNames?: ReadonlySet<string> | null,
): ReapedWorktree[] {
  // (a) merged + (b) failed/cancelled. blocked stays excluded (decomposition
  // parents). ready/wip/claimed/review are live — never reaped here.
  // claimed_by is fetched so the live-worker guard below can short-circuit
  // rows whose session is still in the tmux server's session list.
  const rows = db
    .query(
      `SELECT id, state, worktree_path, branch, claimed_by FROM issues
       WHERE state IN ('merged','failed','cancelled') AND worktree_path IS NOT NULL`,
    )
    .all() as {
    id: string;
    state: string;
    worktree_path: string;
    branch: string | null;
    claimed_by: string | null;
  }[];

  const reaped: ReapedWorktree[] = [];
  for (const row of rows) {
    const wt = row.worktree_path;
    const br = row.branch;

    // Live-worker guard: if the row's claimed_by tmux session is still alive,
    // skip the reap. The factory's reapFinished() runs BEFORE reapWorktrees()
    // in tick(), and a normally-converged tick will see an empty live set
    // (the just-killed session is gone from listWorkers). The guard exists
    // for the cases that don't converge: a reaped worker whose bash subprocess
    // is still alive (the CWD is the reaped worktree, the next bash command
    // would fail), or any other code path that calls reapWorktrees without
    // first passing the worker's session through reapFinished. Cost: one Set
    // lookup per row. The reap fires on the NEXT tick once the session is
    // actually gone — the worktree is just delayed by ≤ the tick interval.
    if (row.claimed_by && liveWorkerNames && liveWorkerNames.has(row.claimed_by)) {
      reaped.push({
        issue_id: row.id,
        worktree_path: wt,
        branch: br,
        outcome: "worker-alive",
        detail: `claimed_by=${row.claimed_by} is still a live tmux session; defer reap to next tick`,
      });
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

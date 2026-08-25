// Worktree reaper: removes the git worktree + branch for issues that are done
// with their worktree and have a worktree_path still recorded on the row.
//
// Three triggers (Aaron's reap policy, 2026-05-27):
//   (a) prune-after-merge   — state=merged rows: work is in main, worktree is
//       scratch, safe to remove. `git worktree remove` never deletes the
//       branch — the loss path is the reaper's best-effort `git branch -D`
//       right after removal, which destroys UNPUSHED commits (a commit on an
//       in-sync upstream survives: origin still holds it). Workers must push
//       the feature branch to origin BEFORE merging the ledger row:
//       `git push -u origin <branch> && git checkout main && git merge <branch>`.
//       Observed loss (2026-06): iter20 write-child committed df29124 to a
//       worktree branch that was reaped before the branch was pushed — commit
//       unrecoverable. See CONTEXT.md "Worktree" and "Reap" for the full
//       lifecycle expectation.
//   (b) prune-after-triage  — state IN (failed,cancelled) rows: the triage/
//       reconcile flow has finished with them. Remove ONLY if the worktree has
//       no at-risk commits — unpushed when the branch has an upstream, or
//       ahead of main otherwise (nothing to salvage). A failed/cancelled
//       row WITH at-risk commits is PRESERVED (outcome=has-commits) so the
//       human can decide salvage. blocked is still excluded — decomposition parents need
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
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type ReapedWorktree = {
  issue_id: string;
  worktree_path: string | null;
  branch: string | null;
  // has-commits: a failed/cancelled row whose worktree has at-risk commits
  // (unpushed vs upstream, or ahead of main when upstream-less) — preserved
  // for human salvage, row untouched.
  // main-working-tree: worktree_path points at a repo's MAIN checkout (not a
  // linked worktree). `git worktree remove` can never delete a main tree, so
  // retrying every tick is a hot loop. We null the columns instead (the work
  // is merged; the path was misrecorded) so the row is never revisited.
  outcome:
    | "removed"
    | "missing"
    | "git-remove-failed"
    | "no-parent-repo"
    | "has-commits"
    // dirty-uncommitted: working tree has uncommitted/untracked changes that
    // `worktree remove -f -f` would force-delete. Preserved for human review.
    | "dirty-uncommitted"
    | "main-working-tree";
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

// Count commits on the worktree's HEAD that would be lost if the local branch
// were deleted — i.e. at-risk work. When the branch has an upstream, count
// against it (`@{u}..HEAD`): a pushed commit survives `branch -D` because
// origin still holds it, so counting against main (the old behavior) mislabeled
// fully-pushed branches like deploy/host-p600 as at-risk. Only upstream-less
// branches fall back to `main..HEAD`. 0 means nothing at risk. Any git failure
// (detached HEAD, no main, corrupt) is treated as "has commits" (return >0)
// so we err on the side of PRESERVING — we never remove a worktree we can't
// prove is safe.
function unpushedCommits(worktreePath: string): number {
  const hasUpstream = git(worktreePath, ["rev-parse", "--verify", "--quiet", "@{u}"]).ok;
  const base = hasUpstream ? "@{u}" : "main";
  const r = git(worktreePath, ["rev-list", "--count", `${base}..HEAD`]);
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

// True when the worktree has uncommitted or untracked changes (`git status
// --porcelain` non-empty). `git worktree remove -f -f` force-deletes these,
// so the reaper must skip a dirty tree even when the row is merged — a merged
// row only means the BRANCH landed, not that scratch edits on top were saved.
// Any git failure returns true (can't prove clean → preserve).
function hasUncommittedChanges(worktreePath: string): boolean {
  const r = git(worktreePath, ["status", "--porcelain"]);
  if (!r.ok) return true;
  return r.out.trim() !== "";
}

// Resolve the GitHub "owner/repo" slug from a local repo's origin remote.
// Returns null when origin is missing or not a github URL — caller treats
// null as "can't determine" and falls back to the conservative keep path.
// SECURITY: spawnSync with array argv only; the URL string is never a shell.
function parseGithubSlug(parentRepo: string): string | null {
  const r = git(parentRepo, ["remote", "get-url", "origin"]);
  if (!r.ok || !r.out) return null;
  const m = r.out.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
  return m && m[1] ? m[1] : null;
}

// Runner seam for `gh pr list` — production calls the real `gh` CLI; tests
// inject a stub. Sync to match the rest of this module's git helpers.
export type GhRunner = (args: string[]) => { ok: boolean; out: string };
export const defaultGhRunner: GhRunner = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
};

// True when `branch` has a merged PR on `slug` (owner/repo). Returns null
// when we can't determine (gh missing, no auth, no origin remote) — the
// reaper then falls through to the conservative kept-has-commits outcome.
// Squash-merged branches show unpushedCommits==1 (no upstream, ahead of main)
// but are dead; the PR
// state on origin is the authoritative answer that branch ancestry can't give.
function ghPrMerged(branch: string, slug: string | null, runner: GhRunner): boolean | null {
  if (!slug) return null;
  const r = runner(["pr", "list", "--repo", slug, "--head", branch, "--state", "merged", "--json", "state"]);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.out) as Array<{ state?: string }>;
    if (arr.length === 0) return false;
    return arr[0]!.state === "MERGED";
  } catch {
    return null;
  }
}

export function reapWorktrees(db: Db): ReapedWorktree[] {
  // (a) merged + (b) failed/cancelled. blocked stays excluded (decomposition
  // parents). ready/wip/claimed/review are live — never reaped here.
  // 021: merged rows are gated on hygiene_complete=1 — the hygiene phase must
  // finish before the worktree is reaped so workers can still emit hygiene
  // followups in the same session. Failed/cancelled rows have no hygiene phase
  // and are reaped unconditionally.
  const rows = db
    .query(
      `SELECT id, state, worktree_path, branch FROM issues
       WHERE state IN ('merged','failed','cancelled') AND worktree_path IS NOT NULL
         AND (state != 'merged' OR hygiene_complete = 1)`,
    )
    .all() as { id: string; state: string; worktree_path: string; branch: string | null }[];

  const reaped: ReapedWorktree[] = [];
  for (const row of rows) {
    const wt = row.worktree_path;
    const br = row.branch;

    // (b) commit-guard: a failed/cancelled worktree with at-risk commits
    // (unpushed vs upstream, or ahead of main when upstream-less) is
    // preserved for human salvage. merged rows skip this — their work is
    // already in main, so the worktree is scratch regardless of "ahead" count.
    // The guard runs only when the dir still exists (unpushedCommits needs
    // a live worktree); a missing dir falls through to the cleanup below.
    if (row.state !== "merged" && existsSync(wt) && unpushedCommits(wt) > 0) {
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

    // Uncommitted/untracked changes would be force-deleted by `-f -f`. Preserve
    // for human review — a merged row only proves the branch landed, not that
    // working-tree edits on top were saved.
    if (hasUncommittedChanges(wt)) {
      reaped.push({ issue_id: row.id, worktree_path: wt, branch: br, outcome: "dirty-uncommitted" });
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
//   - aged past maxAgeSec AND no live ledger row references it AND 0 at-risk
//     commits (unpushed vs upstream, or ahead of main when upstream-less).
// It NEVER removes a dir with at-risk commits (Aaron: "delete nothing" for
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
  // Injected for tests. Defaults to spawning the real `gh` CLI.
  ghRunner?: GhRunner;
};

export function backstopPurgeWorktrees(db: Db, opts: BackstopOpts): BackstopResult[] {
  // parentRepo (opts) intentionally unused: removal resolves each dir's OWN
  // owner repo via findParentRepo — `~/worktrees` is multi-repo.
  const { worktreesRoot, maxAgeSec } = opts;
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

    // Confirm git manages this as a worktree AND resolve its OWN parent repo.
    // `~/worktrees` holds worktrees of many repos, so the remove must run in
    // each dir's owner, not a single fixed parentRepo (old bug: foreign-repo
    // orphans never reaped because `git -C <arc-agents> worktree remove` fails).
    const dirParent = findParentRepo(dir);
    if (!dirParent) {
      results.push({ worktree_path: dir, outcome: "not-a-worktree" });
      continue;
    }

    // A live ledger row owns it — defer to the row-driven reaper.
    if (tracked.has(dir)) {
      results.push({ worktree_path: dir, outcome: "kept-live-row" });
      continue;
    }

    // At-risk commits (unpushed vs upstream, or ahead of main when
    // upstream-less) → never auto-remove (preserve for salvage) UNLESS the
    // branch has a merged PR on origin: squash-merge rewrites history so the
    // branch tip is NOT an ancestor of post-squash origin/main, but the work
    // IS in main. The PR state on origin is the only authoritative answer
    // branch ancestry can't give. ghPrMerged=null means we can't tell → keep.
    // `integrated` is also set true when behindMain > 0 (regular merge).
    const ahead = unpushedCommits(dir);
    const behind = behindMain(dir);
    let integrated = behind > 0;
    if (ahead > 0 && !integrated) {
      const branch = git(dir, ["branch", "--show-current"]).out;
      const mergedPr =
        branch && ghPrMerged(branch, parseGithubSlug(dirParent), opts.ghRunner ?? defaultGhRunner);
      if (mergedPr === true) integrated = true;
      else {
        results.push({ worktree_path: dir, outcome: "kept-has-commits" });
        continue;
      }
    }

    // Integrated (merged or squash-merged) OR aged out: scratch — removable.
    // - integrated: the work is in main; branch tip is irrelevant.
    // - not integrated: pristine fork point that never diverged; only reap
    //   once older than maxAgeSec, so we don't yank a worktree a worker
    //   just created.
    const ageSec = now - Math.floor(st.mtimeMs / 1000);
    if (!integrated && ageSec < maxAgeSec) {
      results.push({ worktree_path: dir, outcome: "kept-too-young" });
      continue;
    }

    // Uncommitted/untracked changes → never force-delete; preserve for salvage.
    if (hasUncommittedChanges(dir)) {
      results.push({ worktree_path: dir, outcome: "kept-has-commits", detail: "uncommitted changes" });
      continue;
    }

    const rm = git(dirParent, ["worktree", "remove", "-f", "-f", dir]);
    if (!rm.ok) {
      results.push({ worktree_path: dir, outcome: "kept-too-young", detail: `git-remove-failed: ${rm.out}` });
      continue;
    }
    results.push({ worktree_path: dir, outcome: "removed" });
  }

  return results;
}

// ---------------------------------------------------------------------------
// (d) tmp-fixture sweep — abandoned test fixtures under $TMPDIR.
//
// Test files root their scratch at `mkdtempSync(join(tmpdir(), "arc-<x>-"))`
// and tear it down in afterEach, which covers pass AND fail. It does NOT cover
// a hung or SIGKILLed run: the process dies before afterEach, the dir survives,
// and any worktree the fixture registered against a real repo survives with it
// as a prunable registration.
//
// 2026-08-20 incident: 52 leftover /tmp/arc-factory-test-* + /tmp/arc-pi-home-*
// dirs and ~51 registered worktrees pointing into them (102 -> 51 after a manual
// rm + prune). A snapshot the same day found 1934 /tmp/arc-* dirs total.
//
// ponytail: mtime age gate, not liveness — a SIGKILLed run leaves no pid to
// check. A full test suite runs in minutes, so the default 6h gate cannot reach
// a fixture that is still in use. Raise ARC_TMP_FIXTURE_MAX_AGE if that changes.
//
// SECURITY: only direct children of `tmpRoot` whose basename matches
// FIXTURE_NAME (an `arc-` prefixed mkdtemp/test scratch name) are considered.
// No shell; rmSync is scoped to the resolved child path.

// `arc-` prefixed AND either a mkdtemp dir (6 trailing random chars) or an
// explicitly test-named scratch dir. Deliberately narrow: a long-lived arc
// runtime dir like `arc-bench` or `arc-cache` must not match.
const FIXTURE_NAME = /^arc-[A-Za-z0-9._-]*(?:-test[A-Za-z0-9._-]*|-[A-Za-z0-9]{6})$/;

export type TmpFixtureResult = {
  path: string;
  outcome: "removed" | "kept-too-young" | "rm-failed";
  detail?: string;
};

export type TmpFixtureOpts = {
  tmpRoot: string;
  // Repo whose worktree registrations are pruned after a removal — fixtures
  // that ran a fake-HOME worker register their worktree here.
  parentRepo: string;
  maxAgeSec: number;
  now?: number; // unix seconds; overridable for tests
};

export function sweepTmpFixtures(opts: TmpFixtureOpts): TmpFixtureResult[] {
  const { tmpRoot, parentRepo, maxAgeSec } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const results: TmpFixtureResult[] = [];

  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return results;
  }

  for (const name of entries) {
    if (!FIXTURE_NAME.test(name)) continue;
    const dir = join(tmpRoot, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const ageSec = now - Math.floor(st.mtimeMs / 1000);
    if (ageSec < maxAgeSec) {
      results.push({ path: dir, outcome: "kept-too-young" });
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      results.push({ path: dir, outcome: "removed" });
    } catch (e) {
      results.push({ path: dir, outcome: "rm-failed", detail: String(e) });
    }
  }

  // Drop registrations whose dir we just deleted. `worktree prune` only touches
  // entries whose directory is already gone, so a live worker is never hit.
  if (results.some((r) => r.outcome === "removed")) git(parentRepo, ["worktree", "prune"]);

  return results;
}

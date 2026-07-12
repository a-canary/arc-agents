// Baseline-HEAD reconcile regression.
//
// worker-shell.sh reuses a worktree across claims. If reconcile counts
// commits with `git rev-list --count main..HEAD`, a worktree left with stale
// commits from a PREVIOUS claim (e.g. an earlier engine that committed then
// crashed) reports those stale commits as "this run's work" even when the
// current engine produced zero new commits and exited non-zero — so the
// engine-failover chain never fires for reused worktrees (analysis
// 2026-07-12, 000033-hygiene-arc-agents-improve-architecture).
//
// Fix: record BASELINE_SHA = HEAD at claim time (after worktree add/reuse,
// before the engine runs), then count `${BASELINE_SHA}..HEAD` instead of
// `main..HEAD`. This test proves the baseline-scoped count is 0 for a
// worktree with stale commits ahead of main, where the old main-scoped count
// would have been nonzero.

import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

test("commits-since-baseline is 0 for a reused worktree with stale commits ahead of main", () => {
  const dir = mkdtempSync(join(tmpdir(), "arc-baseline-test-"));
  try {
    sh("git init -q -b main .", dir);
    sh('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', dir);
    sh("git checkout -q -b worker/some-claim", dir);

    // Simulate a prior claim's stale commit left in the reused worktree.
    sh('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m stale-from-prior-claim', dir);

    // BASELINE_SHA captured at claim time, i.e. AFTER the stale commit exists.
    const baseline = sh("git rev-parse HEAD", dir);

    const staleCount = Number(sh("git rev-list --count main..HEAD", dir));
    expect(staleCount).toBeGreaterThan(0); // old bug: this leaked in as "commits ahead"

    const baselineCount = Number(sh(`git rev-list --count ${baseline}..HEAD`, dir));
    expect(baselineCount).toBe(0); // fixed behavior: no new commits this run
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commits-since-baseline is 1 when the engine adds exactly one new commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "arc-baseline-test-"));
  try {
    sh("git init -q -b main .", dir);
    sh('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', dir);
    sh("git checkout -q -b worker/some-claim", dir);
    sh('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m stale', dir);
    const baseline = sh("git rev-parse HEAD", dir);

    sh('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m new-work', dir);

    const baselineCount = Number(sh(`git rev-list --count ${baseline}..HEAD`, dir));
    expect(baselineCount).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

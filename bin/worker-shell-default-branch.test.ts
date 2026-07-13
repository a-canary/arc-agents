// default_branch_for_repo() tests — repo's default-branch discovery.
//
// Pattern 2 of analysis-1783678328.md: bin/worker-shell.sh hardcoded `main`
// in three sites (fast_forward_main, worktree add base, BASELINE_SHA
// fallback). arc-webui's GitHub default is `master`, so workers branched off
// `main` while production merges landed on `master` — 1 confirmed ghost
// merge (000101) + 8 --in-place --pr merges invisible to future workers
// branching off main. Structural fix: probe the default branch from
// refs/remotes/origin/HEAD (cheap, set by every `git clone`/`remote set-head
// --auto`) with a `gh repo view` fallback, then thread that single value
// through the three call sites.
//
// We source the real script with ARC_WORKER_SHELL_SOURCE_ONLY=1 (same
// harness as the other worker-shell-*.test.ts files) so the helper under
// test is the one production runs, not a copy.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Drive the pure helper against the given repo path. Captures stdout/stderr;
// helper never errors (returns empty stdout on a missing repo so the
// caller's `${VAR:-main}` fallback wins).
function callDefaultBranch(repo: string): { rc: number; out: string; err: string } {
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && default_branch_for_repo "$1"`, SCRIPT, repo],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" },
    },
  );
  return {
    rc: r.status ?? -1,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

// Build a throwaway git repo whose `origin` remote has HEAD pointing at
// `<remoteHead>`. The cheap-path probe (symbolic-ref refs/remotes/origin/HEAD)
// is what production hits on every claim; this fixture sets it directly.
function repoWithOriginHead(remoteHead: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wshell-db-"));
  const run = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: "pipe", encoding: "utf8" }).trim();
  // Init the local repo with the SAME default branch the remote will have;
  // symbolic-ref writes a `refs/remotes/origin/<head>` ref locally, so the
  // branch must already exist on the local side too (git refuses a symbolic
  // ref to a non-existent target).
  run(`git init -q -b ${remoteHead}`);
  run(`git config user.email t@t && git config user.name t`);
  run(`git commit -q --allow-empty -m init`);
  // Build a separate clone as `origin` so origin/<head> is fetchable.
  const origin = mkdtempSync(join(tmpdir(), "wshell-db-origin-"));
  run(`git clone -q "${dir}" "${origin}"`);
  run(`git remote add origin "${origin}"`);
  // Crucially: push the local branch to origin, then set the remote HEAD.
  run(`git push -q origin ${remoteHead}`);
  run(`git remote set-head origin ${remoteHead}`);
  // Sanity: refs/remotes/origin/HEAD is now `refs/remotes/origin/<remoteHead>`.
  const head = run(`git symbolic-ref refs/remotes/origin/HEAD`);
  if (head !== `refs/remotes/origin/${remoteHead}`) {
    throw new Error(
      `fixture broken: refs/remotes/origin/HEAD='${head}' (expected refs/remotes/origin/${remoteHead})`,
    );
  }
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

// Core invariant: the script's own repo (arc-agents, default=main) is
// unchanged. This is the regression guard for the 12 repos in the estate
// that already default to `main` — a "fix" that accidentally forced all
// repos onto a different branch would silently break every worker.
test("default_branch_for_repo returns 'main' for a repo whose origin/HEAD points at main", () => {
  const repo = repoWithOriginHead("main");
  const r = callDefaultBranch(repo);
  expect(r.rc).toBe(0);
  expect(r.out).toBe("main");
});

// The arc-webui regression: the cheap-path probe correctly returns `master`
// (the GH default). This is the regression guard for the production ghost
// merge 000101 — before this fix, workers branched off `main` because
// worker-shell.sh hardcoded that string, regardless of the repo's actual
// default.
test("default_branch_for_repo returns 'master' for a repo whose origin/HEAD points at master", () => {
  const repo = repoWithOriginHead("master");
  const r = callDefaultBranch(repo);
  expect(r.rc).toBe(0);
  expect(r.out).toBe("master");
});

// Ponytail: arbitrary branch names are accepted, not just `main`/`master`.
// `develop`/`trunk`/`release` style repos work without a code change — the
// helper is not coupled to a hardcoded set.
test("default_branch_for_repo accepts arbitrary branch names (develop, trunk, …)", () => {
  for (const branch of ["develop", "trunk", "release"]) {
    const repo = repoWithOriginHead(branch);
    const r = callDefaultBranch(repo);
    expect(r.rc).toBe(0);
    expect(r.out).toBe(branch);
  }
});

// Non-git path → empty stdout. The caller's `${VAR:-main}` fallback wins,
// so a typo or missing repo never escalates to a worker error. Mirrors the
// fast_forward_main contract: missing repo → no-op, not fatal.
test("default_branch_for_repo returns empty for a non-existent path (caller falls back to main)", () => {
  const r = callDefaultBranch("/no/such/path/exists/here");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("");
});

// Empty git repo (no commits, no origin) → empty stdout. The script's own
// repo on a fresh checkout would never hit this path, but a hygiene row
// against a freshly-cloned test fixture might.
test("default_branch_for_repo returns empty for an empty git repo with no remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "wshell-db-empty-"));
  execSync(`git init -q`, { cwd: dir, stdio: "pipe" });
  const r = callDefaultBranch(dir);
  expect(r.rc).toBe(0);
  expect(r.out).toBe("");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
});

// Slow path: when refs/remotes/origin/HEAD is unset (a repo nobody has
// `remote set-head --auto`-ed yet), the helper falls back to `gh repo view`.
// In CI / fresh clones this rarely fires, but a manual `git init` + add
// remote + fetch WITHOUT `set-head` does land here — and we want the same
// answer as the cheap path would have produced. Stub `gh` via PATH-shadow
// to keep the test hermetic.
test("default_branch_for_repo falls back to `gh repo view` when origin/HEAD is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "wshell-db-gh-"));
  const run = (cmd: string) =>
    execSync(cmd, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  run(`git init -q -b trunk`);
  run(`git config user.email t@t && git config user.name t`);
  run(`git commit -q --allow-empty -m init`);
  const origin = mkdtempSync(join(tmpdir(), "wshell-db-gh-origin-"));
  run(`git clone -q "${dir}" "${origin}"`);
  run(`git remote add origin "${origin}"`);
  // Intentionally NO `git remote set-head` — the cheap path returns empty.
  // Shadow `gh` to report `trunk` for any `gh repo view "$repo"` invocation.
  const shim = mkdtempSync(join(tmpdir(), "wshell-db-gh-shim-"));
  // The real gh applies `--jq` internally; our shim must do the same so the
  // script's `gh repo view "$repo" --json X --jq Y` works end-to-end.
  // Parse args to find the filter rather than relying on positional indices.
  writeFileSync(
    join(shim, "gh"),
    `#!/usr/bin/env bash\nif [ "$1" = "repo" ] && [ "$2" = "view" ]; then\n  filter=""\n  while [ "$#" -gt 0 ]; do\n    case "$1" in\n      --jq) filter="$2"; shift 2 ;;\n      *) shift ;;\n    esac\n  done\n  echo '{"defaultBranchRef":{"name":"trunk"}}' | jq -r "$filter"\nfi\n`,
  );
  chmodSync(join(shim, "gh"), 0o755);
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && default_branch_for_repo "$1"`, SCRIPT, dir],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1", PATH: `${shim}:${process.env.PATH}` },
    },
  );
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("trunk");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
      rmSync(shim, { recursive: true, force: true });
    } catch {}
  });
});

// fast_forward_main integration: with the helper routed through the fast
// forward, a `master`-defaulting repo whose origin/master is N commits
// ahead of local `master` advances. This is the SAME end-state as the
// main-scoped test in worker-shell-fast-forward.test.ts, but with a
// non-main default — proves the threaded branch name actually flows
// through fetch/merge-base/merge instead of getting silently dropped.
test("fast_forward_main advances local `master` to origin/master (arc-webui regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wshell-db-ff-"));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
  run(`git init -q -b master`);
  run(`git config user.email t@t && git config user.name t`);
  run(`git commit -q --allow-empty -m init`);
  // Build a separate clone as `origin` and advance it.
  const origin = mkdtempSync(join(tmpdir(), "wshell-db-ff-origin-"));
  run(`git clone -q "${dir}" "${origin}"`);
  for (let i = 0; i < 3; i++) {
    execSync(`git -C "${origin}" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "remote-${i}"`, {
      stdio: "pipe",
    });
  }
  run(`git remote add origin "${origin}"`);
  run(`git fetch -q origin`);
  run(`git remote set-head origin master`);
  // Drive fast_forward_main through the real script.
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && fast_forward_main "$1"`, SCRIPT, dir],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" },
    },
  );
  expect(r.status).toBe(0);
  const local = execSync(`git -C "${dir}" rev-parse master`, { encoding: "utf8" }).trim();
  const remote = execSync(`git -C "${dir}" rev-parse origin/master`, { encoding: "utf8" }).trim();
  expect(local).toBe(remote);
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    } catch {}
  });
});

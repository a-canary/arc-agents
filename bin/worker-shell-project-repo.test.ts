// project_repo_path() cross-project mapping test.
//
// Cross-project rows are routed to a different physical repo by the
// project_repo_path() shell function in worker-shell.sh. The hardcoded case
// table (starlight → expert-horde, starlight-slm → starlight-slm, cli-proxy →
// cli-proxy) is the single source of truth — without a `cli-proxy` entry, a
// row whose `project = cli-proxy` falls through to $REPO and the worker
// spawns inside an empty arc-agents worktree instead of /home/aaron/repos/
// cli-proxy. That's the exact bug observed in task
// 000056-hygiene-cli-proxy-trash-retired-files.
//
// We source the real worker-shell.sh with ARC_WORKER_SHELL_SOURCE_ONLY=1
// (which returns before any claim/exec/PATH munging) and call the function.
// Sourcing the real script — not a copy — is the point: a copy could drift
// from prod.
//
// Test surface covers:
//   - the three known cross-project mappings (regression guard for the bug)
//   - the fallback contract: any unknown project (including arc-agents itself)
//     returns $REPO so the back-compat path is preserved
//   - the ARC_PROJECT_REPO_<project> env override contract (operator escape
//     hatch; dashes in project name become underscores in the env name)
//   - the empty/missing arg case

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");
const DEFAULT_REPO = "/home/aaron/repos/arc-agents";

// Source worker-shell.sh in source-only mode and run project_repo_path with
// the given project arg. The script reads $REPO at call time for the
// fall-through path, so callers can swap it via extraEnv. Returns the trimmed
// stdout (one absolute path on its own line).
function resolve(
  project: string,
  extraEnv: Record<string, string> = {},
): { rc: number; out: string } {
  const env: Record<string, string> = {
    ...process.env,
    ARC_WORKER_SHELL_SOURCE_ONLY: "1",
    REPO: DEFAULT_REPO,
    ...extraEnv,
  };
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "$0" && project_repo_path "$1"`,
      SCRIPT,
      project,
    ],
    { encoding: "utf8", env },
  );
  return { rc: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

// ---- Regression: the cli-proxy fix -----------------------------------------

// The originating bug: project=cli-proxy fell through to $REPO (arc-agents)
// and the worker spawned in the wrong physical repo. Pin the fix.
test("cli-proxy maps to /home/aaron/repos/cli-proxy (not $REPO)", () => {
  const r = resolve("cli-proxy");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/aaron/repos/cli-proxy");
  // Specifically must NOT be the dispatcher's $REPO, which is what the
  // fall-through path returns and what produced the original bug.
  expect(r.out).not.toBe(DEFAULT_REPO);
});

// ---- Other live mappings (sibling guards) ---------------------------------

test("starlight maps to expert-horde (pre-existing entry, regression guard)", () => {
  expect(resolve("starlight").out).toBe("/home/aaron/repos/expert-horde");
});

test("starlight-slm maps to starlight-slm (pre-existing entry, regression guard)", () => {
  expect(resolve("starlight-slm").out).toBe("/home/aaron/repos/starlight-slm");
});

// ---- Back-compat fall-through ---------------------------------------------

// The function is the *only* place that translates logical project name →
// physical repo dir, and every project whose code lives inside arc-agents
// (arc-agents, arc-webui, arc-skills, …) must keep landing in $REPO. A future
// "let's default unknown to something else" edit would silently break
// hundreds of rows.
test("arc-agents falls through to $REPO (no mapping entry)", () => {
  expect(resolve("arc-agents").out).toBe(DEFAULT_REPO);
});

test("any unknown project falls through to $REPO (back-compat path)", () => {
  expect(resolve("arc-webui").out).toBe(DEFAULT_REPO);
  expect(resolve("arc-skills").out).toBe(DEFAULT_REPO);
  expect(resolve("not-a-real-project").out).toBe(DEFAULT_REPO);
  // Stable across calls: idempotent.
  expect(resolve("not-a-real-project").out).toBe(resolve("not-a-real-project").out);
});

test("empty / unset project arg falls through to $REPO", () => {
  // An empty arg (e.g. claim raced and project is null) must not silently
  // land in /home, /tmp, or any other path — the explicit $REPO fall-through
  // is the only safe default because that's what the dispatcher's WORKTREE
  // conventions assume.
  expect(resolve("").out).toBe(DEFAULT_REPO);
});

// ---- Env-var override contract --------------------------------------------

// ARC_PROJECT_REPO_<project> (dashes → underscores in env name) lets operators
// add a new project→repo mapping without editing worker-shell.sh. The override
// wins over the hardcoded table; a bad/missing override falls back to the
// table; an empty override does NOT silently pass through to $REPO.
test("env override wins over the hardcoded table", () => {
  // Pre-existing entry starlight would normally → expert-horde. Override it
  // via env to prove the override contract.
  expect(
    resolve("starlight", { ARC_PROJECT_REPO_starlight: "/tmp/override-starlight" }).out,
  ).toBe("/tmp/override-starlight");
  // The new cli-proxy entry is also overridable, not just the historical ones.
  expect(
    resolve("cli-proxy", { ARC_PROJECT_REPO_cli_proxy: "/tmp/override-cli-proxy" }).out,
  ).toBe("/tmp/override-cli-proxy");
});

test("env override normalizes dashes in project name to underscores", () => {
  // starlight-slm has a dash; bash env names disallow dashes, so the override
  // is keyed by ARC_PROJECT_REPO_starlight_slm (underscored). Pin that the
  // dash form is NOT looked up.
  expect(
    resolve("starlight-slm", { ARC_PROJECT_REPO_starlight_slm: "/tmp/override" }).out,
  ).toBe("/tmp/override");
  // Negative: the dashed form (which can't exist as a real env var) must NOT
  // match — confirms we're sanitizing, not just matching on raw name.
  expect(
    resolve("starlight-slm", { "ARC_PROJECT_REPO_starlight-slm": "/tmp/wrong" }).out,
  ).toBe("/home/aaron/repos/starlight-slm");
});

test("empty env override falls back to the hardcoded table, not $REPO", () => {
  // A misconfigured operator who sets the env var to an empty string would
  // otherwise silently route cli-proxy back to $REPO — exactly the original
  // bug. Pin that empty-string is treated like unset and the hardcoded
  // mapping is used.
  expect(resolve("cli-proxy", { ARC_PROJECT_REPO_cli_proxy: "" }).out).toBe(
    "/home/aaron/repos/cli-proxy",
  );
  expect(resolve("starlight", { ARC_PROJECT_REPO_starlight: "" }).out).toBe(
    "/home/aaron/repos/expert-horde",
  );
});

test("env override pointing at a non-existent dir still resolves (sanity check is caller's job)", () => {
  // The function is pure: it returns the mapped string regardless of whether
  // the dir exists. The "missing dir → fail loud" guard lives at the worktree
  // call site (the `if [[ ! -d "$WT_PARENT" ]]` block in worker-shell.sh), not
  // in this function. Pin the contract so a future "let's pre-validate" edit
  // here doesn't accidentally re-introduce silent failures inside the lookup
  // (or, worse, throw on a non-existent dir and break the pure function).
  expect(
    resolve("cli-proxy", { ARC_PROJECT_REPO_cli_proxy: "/nonexistent/dir" }).out,
  ).toBe("/nonexistent/dir");
});

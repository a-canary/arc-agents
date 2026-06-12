// Repo-routing tests (worker-shell.sh resolve_repo).
//
// Pattern 1 (Part B) of analysis-1780502957.md: bin/worker-shell.sh was
// hardcoding REPO to its own script location (~/repos/arc-agents), so every
// worker — regardless of the row's `project` field — got a worktree off
// arc-agents/main. The fix extracts a pure helper `resolve_repo` that takes
// the row's project name and returns the absolute REPO path, honoring
// ARC_PROJECT_REPO_<UPPER> env overrides and defaulting to ~/repos/<project>.
//
// We drive the REAL script's pure helper via ARC_WORKER_SHELL_SOURCE_ONLY=1
// (a copy could drift from prod), the same pattern worker-shell-watchdog.test.ts
// uses for worker_log_path / stall_timeout_secs.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Source worker-shell.sh in source-only mode and call resolve_repo with the
// given project name under the given env. Returns { rc, out }.
function callResolveRepo(
  project: string,
  env: Record<string, string> = {},
): { rc: number; out: string } {
  // Pin HOME so the default ~/repos/<project> path is fully deterministic;
  // tests that exercise the env-override path also pass HOME so any ${HOME}
  // expansion that sneaks into the override is predictable.
  const mergedEnv = { HOME: "/home/test", ...env };
  const r = spawnSync(
    "bash",
    [
      "-c",
      `source "$0" && resolve_repo "$1"`,
      SCRIPT,
      project,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1", ...mergedEnv },
    },
  );
  return { rc: r.status ?? -1, out: (r.stdout ?? "").trim() };
}

// ---- Default: project → ~/repos/<project> ---------------------------------

test("resolve_repo defaults to ~/repos/<project>/ for a plain project name", () => {
  const r = callResolveRepo("cli-proxy");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/test/repos/cli-proxy");
});

test("resolve_repo works for project=arc-agents (no regression for the script's own repo)", () => {
  // This is the prior hardcoded behavior: the bootstrap script lives at
  // ~/repos/arc-agents/bin/worker-shell.sh, so rows with project=arc-agents
  // must continue to route there. Guards against a hypothetical env override
  // that accidentally points arc-agents at a different path.
  const r = callResolveRepo("arc-agents", { ARC_PROJECT_REPO_ARC_AGENTS: "" });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/test/repos/arc-agents");
});

// ---- Env override: ARC_PROJECT_REPO_<UPPER> -------------------------------

test("ARC_PROJECT_REPO_CLI_PROXY env override beats the ~/repos default", () => {
  // Hyphenated project name "cli-proxy" must map to the env var
  // ARC_PROJECT_REPO_CLI_PROXY (uppercase + underscores). This is the lever a
  // factory uses to point a project at a non-default clone location (e.g. a
  // bare clone on a fast SSD, a fork under a different org, a CI cache).
  const r = callResolveRepo("cli-proxy", {
    ARC_PROJECT_REPO_CLI_PROXY: "/custom/path/cli-proxy",
  });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/custom/path/cli-proxy");
});

test("ARC_PROJECT_REPO_<UPPER> env override works for multi-hyphen project names", () => {
  // Pinned regression test for the tr-translation rule: each hyphen must
  // become an underscore, and the whole thing must be uppercased. A naive
  // `${project^^}` (bash uppercase) would yield "CLI-PROXY" — wrong, the env
  // var name is the all-underscore form ARC_PROJECT_REPO_CLI_PROXY.
  const r = callResolveRepo("starlight-slm", {
    ARC_PROJECT_REPO_STARLIGHT_SLM: "/srv/repos/starlight-slm",
  });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/srv/repos/starlight-slm");
});

test("an empty env override falls through to the ~/repos default", () => {
  // An explicitly empty override is the same as unset — the default must win.
  // (Bash's ${!var:-default} returns the default for an empty var, so this
  // pins that the empty-string branch isn't reachable but the default
  // behaviour is correct anyway.)
  const r = callResolveRepo("bitnet", { ARC_PROJECT_REPO_BITNET: "" });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/test/repos/bitnet");
});

// ---- Edge cases -----------------------------------------------------------

test("resolve_repo falls back to the script's own location for an empty project", () => {
  // Legacy rows (or a malformed claim) may have an empty project field. Rather
  // than routing to ~/repos/ (a nonexistent dir) or hard-failing, fall back
  // to the script's own repo — this preserves the prior hardcoded behavior
  // for any caller that hasn't migrated to the project-aware path yet.
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && resolve_repo ""`, SCRIPT],
    {
      encoding: "utf8",
      env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1" },
    },
  );
  expect(r.status).toBe(0);
  const out = r.stdout.trim();
  // The fallback is the absolute path of the script's parent dir (i.e.
  // dirname($0)/..). In production this is ~/repos/arc-agents; in this test
  // it's the worktree root. The contract is "the absolute path of the dir
  // that holds bin/" — not a specific filename, since the worktree location
  // shifts per-slice. We assert absolute + ends in /bin's parent.
  expect(out.startsWith("/")).toBe(true);
  // dirname(SCRIPT) = .../bin, so dirname(.../bin)/.. = the worktree/repo root.
  // The fallback must equal that root exactly.
  const expected = join(dirname(SCRIPT), "..");
  expect(out).toBe(expected);
});

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

// ---- Hardcoded project → repo mappings (task brief) -----------------------

test("resolve_repo hardcoded: cli-proxy → ~/repos/cli-proxy", () => {
  const r = callResolveRepo("cli-proxy");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/test/repos/cli-proxy");
});

test("resolve_repo hardcoded: expert-horde → ~/repos/expert-horde", () => {
  const r = callResolveRepo("expert-horde");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/test/repos/expert-horde");
});

test("resolve_repo hardcoded: starlight → ~/repos/expert-horde", () => {
  // starlight and expert-horde share the same checkout.
  const r = callResolveRepo("starlight");
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/home/test/repos/expert-horde");
});

test("resolve_repo hardcoded: env override still wins for hardcoded projects", () => {
  // Even a project with a hardcoded mapping must honour the env override
  // so the factory can redirect without editing this script.
  const r = callResolveRepo("expert-horde", {
    ARC_PROJECT_REPO_EXPERT_HORDE: "/override/expert-horde",
  });
  expect(r.rc).toBe(0);
  expect(r.out).toBe("/override/expert-horde");
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

// ---- ensure_pi_on_path: per-user npm prefix resolution -------------------
//
// Headless workers on a no-sudo install (`npm config set prefix ~/.npm-global`)
// died exit 127 `pi: command not found`: the old heuristic only probed node's
// sibling global bin, never the per-user prefix. ensure_pi_on_path now probes
// `npm prefix -g`/bin and ~/.npm-global/bin too. These tests stub a fake `pi`
// under each prefix shape and assert it lands on PATH.

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Run ensure_pi_on_path with a PATH that has NO real `pi`, plus optional fake
// bins planted under a temp HOME / npm-prefix. Returns the post-call PATH as
// reported by `command -v pi` (empty string if still unresolved).
function callEnsurePi(opts: {
  home: string;
  npmPrefixBin?: string; // dir to make `npm prefix -g` report (its /bin gets a pi)
  basePath?: string;
}): { rc: number; piPath: string } {
  // A minimal PATH: coreutils + bun's bash, but deliberately no `pi`. We keep
  // the real dirs so `bash`, `dirname`, `command` work; npm/node may or may not
  // exist here, which is fine — the helper degrades gracefully.
  const basePath = opts.basePath ?? "/usr/bin:/bin";
  const env: Record<string, string> = {
    ...process.env,
    ARC_WORKER_SHELL_SOURCE_ONLY: "1",
    HOME: opts.home,
    PATH: basePath,
  };
  if (opts.npmPrefixBin) env.FAKE_NPM_PREFIX = opts.npmPrefixBin;
  // Shadow `npm` so `npm prefix -g` is deterministic (the test box's real npm
  // would report an unrelated global prefix). A tiny shim dir prepended to PATH.
  const shimDir = mkdtempSync(join(tmpdir(), "npmshim-"));
  if (opts.npmPrefixBin) {
    const shim = join(shimDir, "npm");
    writeFileSync(
      shim,
      `#!/usr/bin/env bash\nif [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then echo "${opts.npmPrefixBin}"; fi\n`,
    );
    chmodSync(shim, 0o755);
    env.PATH = `${shimDir}:${basePath}`;
  }
  const r = spawnSync(
    "bash",
    ["-c", `source "$0" && ensure_pi_on_path && command -v pi || true`, SCRIPT],
    { encoding: "utf8", env },
  );
  rmSync(shimDir, { recursive: true, force: true });
  return { rc: r.status ?? -1, piPath: (r.stdout ?? "").trim() };
}

function plantPi(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const pi = join(dir, "pi");
  writeFileSync(pi, "#!/usr/bin/env bash\necho fake-pi\n");
  chmodSync(pi, 0o755);
  return pi;
}

test("ensure_pi_on_path finds pi under ~/.npm-global/bin (per-user no-sudo prefix)", () => {
  const home = mkdtempSync(join(tmpdir(), "pihome-"));
  try {
    const expected = plantPi(join(home, ".npm-global", "bin"));
    const { rc, piPath } = callEnsurePi({ home });
    expect(rc).toBe(0);
    expect(piPath).toBe(expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensure_pi_on_path finds pi under ~/node_modules/.bin (local non-global install)", () => {
  const home = mkdtempSync(join(tmpdir(), "pihome-"));
  try {
    const expected = plantPi(join(home, "node_modules", ".bin"));
    const { rc, piPath } = callEnsurePi({ home });
    expect(rc).toBe(0);
    expect(piPath).toBe(expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensure_pi_on_path finds pi via `npm prefix -g`/bin", () => {
  const home = mkdtempSync(join(tmpdir(), "pihome-"));
  const prefix = mkdtempSync(join(tmpdir(), "npmprefix-"));
  try {
    const expected = plantPi(join(prefix, "bin"));
    const { rc, piPath } = callEnsurePi({ home, npmPrefixBin: prefix });
    expect(rc).toBe(0);
    expect(piPath).toBe(expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("ensure_pi_on_path is a no-op (rc 0) when pi is nowhere to be found", () => {
  const home = mkdtempSync(join(tmpdir(), "pihome-"));
  try {
    const { rc, piPath } = callEnsurePi({ home });
    expect(rc).toBe(0); // never fatal — must not kill the worker
    expect(piPath).toBe(""); // genuinely unresolved
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

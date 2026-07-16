import { test, expect } from "bun:test";
import { extractPrNumber, parsePrUrl, verifyLocalMerged, verifyMergeTruth, defaultRunner, type Runner } from "./merge-truth";

const okRunner = (stdout: string, exitCode = 0): Runner => async () => ({ stdout, exitCode });
// Captures the args gh was called with so we can assert --repo is passed
// when the input was a full PR URL (cross-repo PR# collision guard).
const captureRunner = (stdout: string, exitCode = 0): { runner: Runner; calls: Array<{ cmd: string; args: string[] }> } => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout, exitCode };
  };
  return { runner, calls };
};

test("extractPrNumber parses URLs and #N", () => {
  expect(extractPrNumber("https://github.com/foo/bar/pull/42")).toBe(42);
  expect(extractPrNumber("#7")).toBe(7);
  expect(extractPrNumber("7")).toBe(7);
  expect(extractPrNumber("feat/foo")).toBeNull();
  expect(extractPrNumber("")).toBeNull();
  expect(extractPrNumber(null)).toBeNull();
});

test("parsePrUrl extracts owner/repo/number from full URL", () => {
  expect(parsePrUrl("https://github.com/foo/bar/pull/42")).toEqual({ owner: "foo", repo: "bar", number: 42 });
  expect(parsePrUrl("https://github.com/a-canary/arc-skills/pull/63/")).toEqual({ owner: "a-canary", repo: "arc-skills", number: 63 });
  expect(parsePrUrl("#7")).toBeNull();
  expect(parsePrUrl("7")).toBeNull();
  expect(parsePrUrl("feat/foo")).toBeNull();
});

test("verifyMergeTruth refuses when neither pr nor sha given", async () => {
  const r = await verifyMergeTruth({ prUrl: null, localSha: null, run: okRunner("") });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("--pr");
});

test("verifyMergeTruth refuses when pr_url isn't parseable", async () => {
  const r = await verifyMergeTruth({ prUrl: "feat/foo", localSha: null, run: okRunner("MERGED") });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("does not look like a PR URL");
});

test("verifyMergeTruth refuses when gh reports OPEN", async () => {
  const r = await verifyMergeTruth({
    prUrl: "https://github.com/x/y/pull/9",
    localSha: null,
    run: okRunner("OPEN"),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("expected 'MERGED'");
});

test("verifyMergeTruth refuses when gh reports CLOSED and stays CLOSED across retries", async () => {
  // gh can report stale CLOSED for ~30-90s after a real merge (see
  // analysis-1783934669.md Pattern 1). verifyMergeTruth retries CLOSED with
  // bounded backoff. Here we exhaust all 4 attempts (1 initial + 3 retries)
  // and CLOSED never becomes MERGED → final refusal. No sleep injected, so
  // the test runs instantly.
  const { runner, calls } = captureRunner("CLOSED");
  const r = await verifyMergeTruth({
    prUrl: "#92",
    localSha: null,
    run: runner,
    sleep: () => Promise.resolve(),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("'CLOSED'");
  // 1 initial attempt + 3 retries = 4 total gh calls before final refusal.
  expect(calls).toHaveLength(4);
});

test("verifyMergeTruth accepts MERGED after transient CLOSED (bounded retry)", async () => {
  // Simulates the race window: first three gh reads return CLOSED (stale
  // cache), fourth returns MERGED. With bounded retry + zero sleep, the
  // function succeeds and gh was called 4 times.
  const schedule = ["CLOSED", "CLOSED", "CLOSED", "MERGED"];
  const { runner, calls } = captureRunner(""); // default unused; overridden below
  let i = 0;
  const seqRunner: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: schedule[i++] ?? "MERGED", exitCode: 0 };
  };
  const r = await verifyMergeTruth({
    prUrl: "https://github.com/x/y/pull/88",
    localSha: null,
    run: seqRunner,
    sleep: () => Promise.resolve(),
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.route).toBe("pr");
    expect(r.detail).toContain("x/y#88");
  }
  expect(calls).toHaveLength(4);
});

test("verifyMergeTruth OPEN state is NOT retried (real non-merge)", async () => {
  // OPEN is not a stale-cache symptom — it's a real "PR is still open"
  // signal. We refuse on the first read; no retry, no sleep.
  const { runner, calls } = captureRunner("OPEN");
  const r = await verifyMergeTruth({
    prUrl: "#9",
    localSha: null,
    run: runner,
    sleep: () => Promise.resolve(),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("'OPEN'");
  expect(calls).toHaveLength(1);
});

test("verifyMergeTruth CLOSED-retry detail mentions bounded attempts", async () => {
  // The refusal message after exhausting retries should make it clear the
  // guard waited through the bounded retry window before giving up, so
  // workers know it wasn't a single-shot flake.
  const { runner, calls } = captureRunner("CLOSED");
  const r = await verifyMergeTruth({
    prUrl: "#92",
    localSha: null,
    run: runner,
    sleep: () => Promise.resolve(),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("'CLOSED'");
    expect(r.reason).toMatch(/retry|attempt/i);
  }
  expect(calls).toHaveLength(4);
});

test("verifyMergeTruth uses injected sleep (default is real setTimeout)", async () => {
  // Sleep call counter — verify the default sleep path is the real
  // setTimeout-shaped promise. We can't intercept setTimeout, but we can
  // verify the optional sleep parameter is honored when supplied (zero
  // calls to sleep when gh returns MERGED on first try).
  let sleepCalls = 0;
  const r = await verifyMergeTruth({
    prUrl: "#1",
    localSha: null,
    run: okRunner("MERGED"),
    sleep: () => {
      sleepCalls++;
      return Promise.resolve();
    },
  });
  expect(r.ok).toBe(true);
  expect(sleepCalls).toBe(0); // no retry needed
});

test("verifyMergeTruth accepts MERGED via PR url", async () => {
  // Full URL → gh must be called with --repo owner/repo so the PR number
  // resolves against the right repo (cross-repo PR# collision guard —
  // analysis-1780502957 Pattern 4).
  const { runner, calls } = captureRunner("MERGED");
  const r = await verifyMergeTruth({
    prUrl: "https://github.com/x/y/pull/88",
    localSha: null,
    run: runner,
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.route).toBe("pr");
    expect(r.detail).toContain("x/y#88");
  }
  expect(calls).toHaveLength(1);
  const args = calls[0]!.args;
  expect(args).toContain("--repo");
  expect(args[args.indexOf("--repo") + 1]).toBe("x/y");
});

test("verifyMergeTruth skips --repo when prUrl is a bare #N (cwd fallback)", async () => {
  // Bare #N has no owner/repo to pass; --repo can't be supplied from the
  // input alone. We fall through to cwd resolution (existing behaviour)
  // and surface this in the detail string so failure modes are diagnostic.
  const { runner, calls } = captureRunner("MERGED");
  const r = await verifyMergeTruth({ prUrl: "#92", localSha: null, run: runner });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.route).toBe("pr");
    expect(r.detail).toContain("cwd-resolved");
  }
  expect(calls[0]!.args).not.toContain("--repo");
});

test("verifyMergeTruth skips --repo when prUrl is numeric", async () => {
  const { runner, calls } = captureRunner("MERGED");
  await verifyMergeTruth({ prUrl: "92", localSha: null, run: runner });
  expect(calls[0]!.args).not.toContain("--repo");
});

test("verifyMergeTruth refuses non-hex local sha", async () => {
  const r = await verifyMergeTruth({ prUrl: null, localSha: "deadbeans", run: okRunner("") });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("not a hex sha");
});

test("verifyMergeTruth accepts local sha that is ancestor of origin/main", async () => {
  const r = await verifyMergeTruth({
    prUrl: null,
    localSha: "239838c",
    run: okRunner("", 0),
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.route).toBe("local");
});

test("verifyMergeTruth refuses local sha not on origin/main", async () => {
  const r = await verifyMergeTruth({
    prUrl: null,
    localSha: "deadbee",
    run: okRunner("", 1),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("not an ancestor");
});

test("verifyMergeTruth prefers local-sha route when both supplied", async () => {
  // local route takes precedence; pr route would have refused (gh missing)
  const r = await verifyMergeTruth({
    prUrl: "#1",
    localSha: "239838c",
    run: okRunner("", 0),
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.route).toBe("local");
});

// --in-place escape hatch ---------------------------------------------------
//
// Route 3: an explicit "I assert this is merged in-place, no PR" path. The
// CLI refuses to set both --pr and --in-place; verifyMergeTruth therefore
// sees inPlace only when prUrl is null and the row's pr_url has been
// ignored. The function still accepts a local-sha alongside inPlace (local
// route takes precedence — verifiable evidence wins over assertion).

test("verifyMergeTruth accepts inPlace when no prUrl and no localSha", async () => {
  const r = await verifyMergeTruth({ prUrl: null, localSha: null, inPlace: true, run: okRunner("") });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.route).toBe("in-place");
    expect(r.detail).toContain("in-place");
  }
});

test("verifyMergeTruth refuses when prUrl malformed and inPlace false", async () => {
  // Strengthens the malformed-pr_url case: branch-shaped strings must be
  // rejected even when localSha is set, unless the worker explicitly opts
  // in via inPlace. The CLI mutex between --in-place and --pr is enforced
  // one layer up; here we just exercise the function's contract.
  const r = await verifyMergeTruth({
    prUrl: "cli-proxy:worker/cli-proxy-harden-gitignore",
    localSha: null,
    inPlace: false,
    run: okRunner("MERGED"),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("does not look like a PR URL");
});

test("verifyMergeTruth refusal message mentions --in-place as an option", async () => {
  const r = await verifyMergeTruth({ prUrl: null, localSha: null, run: okRunner("") });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain("--pr");
    expect(r.reason).toContain("--in-place");
  }
});

test("verifyMergeTruth prefers local-sha route over inPlace when both supplied", async () => {
  // local-sha is the strongest claim (verifiable on origin/main); inPlace
  // is the assertion fallback. If a worker passes both, the verifiable
  // route wins. CLI does not enforce a mutex between the two, only against
  // --pr.
  const r = await verifyMergeTruth({
    prUrl: null,
    localSha: "239838c",
    inPlace: true,
    run: okRunner("", 0),
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.route).toBe("local");
});

// --- defaultRunner factory (analysis-1783937189 Pattern 1) -----------------
//
// Pre-fix bug: defaultRunner was a Runner (not a factory), spawned git/gh
// from the caller's inherited cwd with no stderr capture, no timeout. When
// the worker was in a non-repo cwd (e.g. a reaped worktree, ~/trash/<ts>/,
// or just ~/) git exited 128 and the operator saw a trailing-colon refusal
// with no reason. 32 churn events across 10 projects in 23d.
//
// Post-fix: defaultRunner(project) returns a Runner that pins cwd to
// ~/repos/<repoDir> via resolveProjectRepo, captures stderr into the
// result.stdout so the operator-facing message includes the actual git
// error, and times out at 30s.

test("defaultRunner is a factory, not a Runner (accepts a project argument)", () => {
  // Type check + behavioural: invoking defaultRunner with a project
  // returns a function, not a Promise.
  const runner = defaultRunner("arc-agents");
  expect(typeof runner).toBe("function");
});

test("defaultRunner factory accepts null and undefined project (falls back to process.cwd)", () => {
  // A row with no project field (NULL in the DB) is a degenerate case but
  // must not crash the runner factory — it should fall back to the
  // inherited process.cwd() like the pre-fix behaviour.
  expect(() => defaultRunner(null)).not.toThrow();
  expect(() => defaultRunner(undefined)).not.toThrow();
});

test("defaultRunner pins spawned git to ~/repos/<project> (cwd resolved from project field)", async () => {
  // We can't reach inside Bun.spawn from a test, so we exercise the path
  // by invoking a command that prints its own cwd and asserting the result
  // is the project repo (the path pinned by the env override) — NOT the
  // worktree dir (`bun test` runs from). This is the exact failure mode
  // that triggered Pattern 1: git in the wrong cwd.
  //
  // We use the env override to pin a known path, so the test is
  // environment-independent (it does not depend on ~/repos/arc-agents
  // existing on the host).
  const tmp = "/tmp/arc-agents-cwd-fixture";
  const previous = process.env.ARC_PROJECT_REPO_ARC_AGENTS;
  process.env.ARC_PROJECT_REPO_ARC_AGENTS = tmp;
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(tmp, { recursive: true });
  try {
    const runner = defaultRunner("arc-agents");
    const r = await runner("pwd", []);
    expect(r.exitCode).toBe(0);
    // Resolve absolute path: `pwd` on Linux prints the canonical path
    // with no symlinks. The runner pinned cwd to the env override.
    expect(r.stdout.trim()).toBe(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ARC_PROJECT_REPO_ARC_AGENTS;
    else process.env.ARC_PROJECT_REPO_ARC_AGENTS = previous;
  }
});

test("defaultRunner captures stderr into stdout so the operator-facing message includes the actual reason", async () => {
  // Force git to fail with stderr output. The pre-fix runner piped stderr
  // but never drained it into the result, so the operator saw
  // `git merge-base exited 128: ` (empty). Post-fix, the actual stderr
  // ("fatal: not a git repository") surfaces in the refusal.
  //
  // We invoke a command that writes a known error to stderr; pwd is
  // harmless so we use git with a flag it doesn't understand. The point
  // is the stderr is in the result, not empty.
  const runner = defaultRunner(null);
  const r = await runner("git", ["--definitely-not-a-real-flag"]);
  expect(r.exitCode).not.toBe(0);
  // Bun's spawn captures stderr into proc.stderr; the factory drains and
  // appends it to stdout. The merged result must contain the actual
  // reason, not be empty.
  expect(r.stdout.length).toBeGreaterThan(0);
});

test("defaultRunner end-to-end: verifyLocalMerged refusal includes git stderr (regression for analysis-1783937189 Pattern 1)", async () => {
  // This is the actual operator-facing failure mode. Pre-fix: from a
  // non-repo cwd, verifyLocalMerged returned
  //   { ok: false, reason: "git merge-base exited 128: " }
  // (trailing colon, empty reason). Post-fix: the same call surfaces the
  // actual git reason (e.g. "fatal: Not a valid object name 0000000") so
  // an operator can diagnose without grepping the code.
  const runner = defaultRunner("arc-agents");
  const r = await verifyLocalMerged("0000000", runner);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    // The reason must include the actual git error text, not a trailing
    // colon and nothing. Pin the pre-fix bug here: if the reason ends
    // with `: ` (colon-space) the stderr capture has regressed.
    expect(r.reason).not.toMatch(/:\s*$/);
    expect(r.reason).toContain("fatal:");
  }
});

test("defaultRunner falls back to process.cwd() when project has no resolvable repo", async () => {
  // An unknown project (e.g. typo) must not throw — the runner falls back
  // to process.cwd() so the caller gets a real error message, not a
  // runtime crash. We can't reach the cwd from inside the factory, but we
  // can verify the factory doesn't throw and the resulting runner
  // executes successfully.
  const runner = defaultRunner("this-project-does-not-exist-xyz");
  const r = await runner("pwd", []);
  expect(r.exitCode).toBe(0);
  // The fallback cwd is whatever process.cwd() resolves to at call time
  // (the worktree dir under test). We only assert the runner returns
  // without throwing — the actual path is environment-dependent.
  expect(r.stdout.length).toBeGreaterThan(0);
});

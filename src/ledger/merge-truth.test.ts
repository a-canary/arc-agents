import { test, expect } from "bun:test";
import { extractPrNumber, parsePrUrl, verifyMergeTruth, type Runner } from "./merge-truth";

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

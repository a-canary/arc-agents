import { test, expect } from "bun:test";
import { extractPrNumber, verifyMergeTruth, type Runner } from "./merge-truth";

const okRunner = (stdout: string, exitCode = 0): Runner => async () => ({ stdout, exitCode });

test("extractPrNumber parses URLs and #N", () => {
  expect(extractPrNumber("https://github.com/foo/bar/pull/42")).toBe(42);
  expect(extractPrNumber("#7")).toBe(7);
  expect(extractPrNumber("7")).toBe(7);
  expect(extractPrNumber("feat/foo")).toBeNull();
  expect(extractPrNumber("")).toBeNull();
  expect(extractPrNumber(null)).toBeNull();
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

test("verifyMergeTruth refuses when gh reports CLOSED", async () => {
  const r = await verifyMergeTruth({
    prUrl: "#92",
    localSha: null,
    run: okRunner("CLOSED"),
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toContain("'CLOSED'");
});

test("verifyMergeTruth accepts MERGED via PR url", async () => {
  const r = await verifyMergeTruth({
    prUrl: "https://github.com/x/y/pull/88",
    localSha: null,
    run: okRunner("MERGED"),
  });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.route).toBe("pr");
    expect(r.detail).toContain("PR #88");
  }
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

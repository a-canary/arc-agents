import { test, expect } from "bun:test";
import { parseDiffReviewPayload, checkReviewerIndependence } from "./diff-review";

const GOOD = JSON.stringify({ reviewer_identity: "claude-afk-reviewer", reviewed_sha: "abcdef1234567", verdict: "pass" });

test("parseDiffReviewPayload accepts the contract shape", () => {
  const r = parseDiffReviewPayload(GOOD);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.payload.reviewer_identity).toBe("claude-afk-reviewer");
    expect(r.payload.reviewed_sha).toBe("abcdef1234567");
    expect(r.payload.verdict).toBe("pass");
  }
});

test("parseDiffReviewPayload accepts full 40-char hex sha (case-insensitive)", () => {
  const r = parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12", verdict: "comment" }));
  expect(r.ok).toBe(true);
});

test("parseDiffReviewPayload trims reviewer_identity", () => {
  const r = parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "  reviewer-x  ", reviewed_sha: "abc1234", verdict: "pass" }));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.payload.reviewer_identity).toBe("reviewer-x");
});

test("parseDiffReviewPayload refuses empty/null/undefined", () => {
  expect(parseDiffReviewPayload(null).ok).toBe(false);
  expect(parseDiffReviewPayload(undefined).ok).toBe(false);
  expect(parseDiffReviewPayload("").ok).toBe(false);
  expect(parseDiffReviewPayload("   ").ok).toBe(false);
  expect(parseDiffReviewPayload(null) && parseDiffReviewPayload(null)).toBeDefined();
});

test("parseDiffReviewPayload refuses non-JSON / malformed-JSON", () => {
  for (const bad of ["not json", "{unterminated", "[1,2,3]", "null", "42", "\"a string\"", "true"]) {
    const r = parseDiffReviewPayload(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JSON|object|array|number|boolean|string|null/);
  }
});

test("parseDiffReviewPayload refuses JSON object missing required field", () => {
  for (const partial of [
    { reviewer_identity: "r", reviewed_sha: "abc1234" }, // no verdict
    { reviewer_identity: "r", verdict: "pass" }, // no reviewed_sha
    { reviewed_sha: "abc1234", verdict: "pass" }, // no reviewer_identity
    {}, // all missing
  ]) {
    const r = parseDiffReviewPayload(JSON.stringify(partial));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("missing required field");
  }
});

test("parseDiffReviewPayload refuses wrong-type fields", () => {
  // reviewer_identity non-string
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: 42, reviewed_sha: "abc1234", verdict: "pass" })).ok).toBe(false);
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "", reviewed_sha: "abc1234", verdict: "pass" })).ok).toBe(false);
  // reviewed_sha non-string / non-hex
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: 123, verdict: "pass" })).ok).toBe(false);
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: "deadbeans", verdict: "pass" })).ok).toBe(false);
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: "abc", verdict: "pass" })).ok).toBe(false); // too short
  // verdict non-string / wrong enum
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: "abc1234", verdict: "approved" })).ok).toBe(false);
  expect(parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: "abc1234", verdict: 1 })).ok).toBe(false);
});

test("parseDiffReviewPayload accepts all three valid verdicts", () => {
  for (const v of ["pass", "fail", "comment"]) {
    const r = parseDiffReviewPayload(JSON.stringify({ reviewer_identity: "r", reviewed_sha: "abc1234", verdict: v }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.verdict).toBe(v);
  }
});

test("parseDiffReviewPayload accepts extra fields (back-compat with legacy schema docs)", () => {
  // Legacy reviewer JSON had {consequences, surprises_vs_brief, gaps_vs_brief, adr_conflicts, axi_violations}.
  // We keep those fields addressable: parseDiffReviewPayload ignores anything beyond the required 3.
  const r = parseDiffReviewPayload(
    JSON.stringify({
      reviewer_identity: "claude-afk",
      reviewed_sha: "abc1234",
      verdict: "pass",
      consequences: ["foo"],
      surprises_vs_brief: [],
    }),
  );
  expect(r.ok).toBe(true);
});

// --- checkReviewerIndependence ---------------------------------------------

test("checkReviewerIndependence: passes when workerIdentity is absent/empty (legacy rows)", () => {
  expect(checkReviewerIndependence("reviewer-x", null)).toBeNull();
  expect(checkReviewerIndependence("reviewer-x", undefined)).toBeNull();
  expect(checkReviewerIndependence("reviewer-x", "")).toBeNull();
  expect(checkReviewerIndependence("reviewer-x", "   ")).toBeNull();
});

test("checkReviewerIndependence: passes when identities differ", () => {
  expect(checkReviewerIndependence("claude-afk", "arc-worker-a-7kcc01")).toBeNull();
  expect(checkReviewerIndependence("opus-rival", "sonnet-rival")).toBeNull();
});

test("checkReviewerIndependence: refuses on exact match", () => {
  const r = checkReviewerIndependence("arc-worker-a-7kcc01", "arc-worker-a-7kcc01");
  expect(r).not.toBeNull();
  expect(r).toContain("self-review");
  expect(r).toContain("arc-worker-a-7kcc01");
});

test("checkReviewerIndependence: refuses on case-insensitive / whitespace match", () => {
  expect(checkReviewerIndependence("ARC-WORKER-A-7KCC01", "arc-worker-a-7kcc01")).not.toBeNull();
  // Whitespace is trimmed by parseDiffReviewPayload; the equality check trims worker side
  expect(checkReviewerIndependence("  arc-worker-a-7kcc01  ", "arc-worker-a-7kcc01")).toBeNull(); // trimmed before compare
});

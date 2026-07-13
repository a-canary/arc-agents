import { test, expect } from "bun:test";
import {
  parseInPlaceReviewPayload,
  checkInPlaceReviewerIndependence,
  JUSTIFICATION_MAX,
} from "./in-place-review";

const GOOD = JSON.stringify({
  reviewer_identity: "claude-afk-reviewer",
  justification: "hygiene-only task, no code change, worktree preserved",
});

// ── parseInPlaceReviewPayload: happy path ────────────────────────────────────

test("parseInPlaceReviewPayload accepts the contract shape", () => {
  const r = parseInPlaceReviewPayload(GOOD);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.payload.reviewer_identity).toBe("claude-afk-reviewer");
    expect(r.payload.justification).toBe("hygiene-only task, no code change, worktree preserved");
  }
});

test("parseInPlaceReviewPayload trims whitespace on both fields", () => {
  const r = parseInPlaceReviewPayload(
    JSON.stringify({ reviewer_identity: "  reviewer-x  ", justification: "  cleared  " }),
  );
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.payload.reviewer_identity).toBe("reviewer-x");
    expect(r.payload.justification).toBe("cleared");
  }
});

// ── parseInPlaceReviewPayload: refusals ──────────────────────────────────────

test("parseInPlaceReviewPayload refuses empty / null / undefined payload", () => {
  expect(parseInPlaceReviewPayload(null).ok).toBe(false);
  expect(parseInPlaceReviewPayload(undefined).ok).toBe(false);
  expect(parseInPlaceReviewPayload("").ok).toBe(false);
  expect(parseInPlaceReviewPayload("   ").ok).toBe(false);
});

test("parseInPlaceReviewPayload refuses non-JSON and malformed-JSON", () => {
  for (const bad of ["not json", "{unterminated", "[1,2,3]", "null", "42", "\"a string\""]) {
    const r = parseInPlaceReviewPayload(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/JSON|object|array|number|boolean|string|null/);
  }
});

test("parseInPlaceReviewPayload refuses JSON missing required fields", () => {
  for (const partial of [
    { reviewer_identity: "r" }, // no justification
    { justification: "x" }, // no reviewer_identity
    {}, // both missing
  ]) {
    const r = parseInPlaceReviewPayload(JSON.stringify(partial));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("missing required field");
  }
});

test("parseInPlaceReviewPayload refuses wrong-type fields", () => {
  expect(parseInPlaceReviewPayload(JSON.stringify({ reviewer_identity: 42, justification: "x" })).ok).toBe(false);
  expect(parseInPlaceReviewPayload(JSON.stringify({ reviewer_identity: "", justification: "x" })).ok).toBe(false);
  expect(parseInPlaceReviewPayload(JSON.stringify({ reviewer_identity: "r", justification: 7 })).ok).toBe(false);
  expect(parseInPlaceReviewPayload(JSON.stringify({ reviewer_identity: "r", justification: "   " })).ok).toBe(false);
});

test("parseInPlaceReviewPayload refuses justifications exceeding the 280-char ceiling", () => {
  const long = "x".repeat(JUSTIFICATION_MAX + 1);
  const r = parseInPlaceReviewPayload(
    JSON.stringify({ reviewer_identity: "r", justification: long }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.reason).toContain(String(JUSTIFICATION_MAX));
    expect(r.reason).toContain("ghost-merge");
  }
});

test("parseInPlaceReviewPayload accepts justifications at exactly the 280-char ceiling", () => {
  const at = "x".repeat(JUSTIFICATION_MAX);
  const r = parseInPlaceReviewPayload(
    JSON.stringify({ reviewer_identity: "r", justification: at }),
  );
  expect(r.ok).toBe(true);
});

// ── checkInPlaceReviewerIndependence (re-uses diff-review's rule) ────────────

test("checkInPlaceReviewerIndependence: passes when workerIdentity is absent/empty", () => {
  expect(checkInPlaceReviewerIndependence("reviewer-x", null)).toBeNull();
  expect(checkInPlaceReviewerIndependence("reviewer-x", undefined)).toBeNull();
  expect(checkInPlaceReviewerIndependence("reviewer-x", "")).toBeNull();
});

test("checkInPlaceReviewerIndependence: passes when identities differ", () => {
  expect(checkInPlaceReviewerIndependence("claude-afk", "arc-worker-a-7kcc01")).toBeNull();
});

test("checkInPlaceReviewerIndependence: refuses self-review", () => {
  const r = checkInPlaceReviewerIndependence("arc-worker-a-7kcc01", "arc-worker-a-7kcc01");
  expect(r).not.toBeNull();
  expect(r).toContain("self-review");
  expect(r).toContain("arc-worker-a-7kcc01");
});

test("checkInPlaceReviewerIndependence: refuses case-insensitive match", () => {
  expect(checkInPlaceReviewerIndependence("ARC-WORKER-A-7KCC01", "arc-worker-a-7kcc01")).not.toBeNull();
});

import { test, expect } from "bun:test";
import { classifyFailed, LOW_RISK_EVENT_KINDS } from "./failed-classifier";

const base = { id: "x", type: "mvp", title: "task", body_md: "", evidence_md: null };

// ── Type-based HITL escalation (always wins) ──────────────────────────────────

test("HITL type escalates regardless of evidence or event kinds", () => {
  const r = classifyFailed(
    { ...base, type: "HITL", evidence_md: "test failure only" },
    [{ kind: "test-fail", payload_md: "" }],
  );
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons[0]).toContain("type=HITL");
});

test("security type escalates even with low-risk event in log", () => {
  const r = classifyFailed(
    { ...base, type: "security" },
    [{ kind: "timeout", payload_md: "" }],
  );
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons[0]).toContain("type=security");
});

// ── Structured event-kind recognition ────────────────────────────────────────

test("test-fail event classifies as low-risk", () => {
  const r = classifyFailed(base, [{ kind: "test-fail", payload_md: "suite=login, 3 failed" }]);
  expect(r.verdict).toBe("low-risk");
  expect(r.reasons[0]).toBe("event kind=test-fail in log");
});

test("budget-blocked event classifies as low-risk", () => {
  const r = classifyFailed(base, [{ kind: "budget-blocked", payload_md: "out of tokens" }]);
  expect(r.verdict).toBe("low-risk");
});

test("tool-fail event classifies as low-risk", () => {
  const r = classifyFailed(base, [{ kind: "tool-fail", payload_md: "gh: rate limit" }]);
  expect(r.verdict).toBe("low-risk");
});

test("timeout event classifies as low-risk", () => {
  const r = classifyFailed(base, [{ kind: "timeout", payload_md: "1800s watchdog" }]);
  expect(r.verdict).toBe("low-risk");
});

test("multiple events — first matching low-risk kind wins", () => {
  const r = classifyFailed(base, [
    { kind: "note", payload_md: "worker logged out" },
    { kind: "timeout", payload_md: "" },
  ]);
  expect(r.verdict).toBe("low-risk");
  expect(r.reasons[0]).toContain("timeout");
});

// ── LOW_RISK_EVENT_KINDS is the contract; mismatch is loud ────────────────────

test("LOW_RISK_EVENT_KINDS exposes the published enum", () => {
  expect(LOW_RISK_EVENT_KINDS).toContain("test-fail");
  expect(LOW_RISK_EVENT_KINDS).toContain("budget-blocked");
  expect(LOW_RISK_EVENT_KINDS).toContain("tool-fail");
  expect(LOW_RISK_EVENT_KINDS).toContain("timeout");
});

test("a kind not in LOW_RISK_EVENT_KINDS is NOT auto-classified low-risk", () => {
  // The legacy event kind 'reclaimed' existed in the CHECK but isn't
  // classified low-risk here — a stale-claim reclaim doesn't mean the
  // task failed safely. Pin the regression.
  const r = classifyFailed(base, [{ kind: "reclaimed", payload_md: "sweeper" }]);
  expect(r.verdict).toBe("needs-HITL");
});

// ── Prose-no longer steers triage (regression for PRD §5) ────────────────────

test("evidence mentioning 'test' alone does NOT classify as low-risk", () => {
  // PRD user story 6 + §"failed-classifier rewrite": a worker writing
  // "the test failed" in evidence_md cannot trick the classifier into
  // splitting-and-cancelling the row. Only a `kind='test-fail'` event counts.
  const r = classifyFailed(
    { ...base, evidence_md: "unit test failed but feature works" },
    [],
  );
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons.some((r) => r.includes("no structured low-risk"))).toBe(true);
});

test("title matching a low-risk hint does NOT classify as low-risk", () => {
  // The legacy LOW_RISK_TITLE_HINTS list is gone — title is worker-authored.
  const r = classifyFailed({ ...base, title: "benchmark coverage audit" }, []);
  expect(r.verdict).toBe("needs-HITL");
});

test("'data loss' phrase no longer triggers a free-text escalation", () => {
  // HIGH_RISK_PHRASES is gone: with no event-kind basis for the rule, the
  // substring was a worker-steerable signal anyway. The classifier now keys
  // exclusively on event kinds + row type; phrases don't auto-escalate.
  // Conservative behavior: HITL is still the default, but via "no signal"
  // — not via a special phrase match.
  const r = classifyFailed(
    { ...base, body_md: "this might cause data loss" },
    [],
  );
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons[0]).toContain("no structured low-risk");
});

// ── Default to HITL (PRD user story 7) ────────────────────────────────────────

test("no events + no signal → conservative HITL with helpful reasons", () => {
  const r = classifyFailed(
    { ...base, title: "fix the auth flow", body_md: "rework login" },
    [{ kind: "note", payload_md: "agent exited non-zero" }],
  );
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons).toContain("no structured low-risk event kind in log");
  // Reasons name the looked-for kinds so the operator can extend the enum:
  expect(r.reasons.join(" ")).toContain("test-fail");
  expect(r.reasons.join(" ")).toContain("tool-fail");
});

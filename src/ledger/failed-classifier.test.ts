import { test, expect } from "bun:test";
import { classifyFailed } from "./failed-classifier";

const base = { id: "x", hitl: 0, class: "MVP", title: "task", body_md: "", evidence_md: null };

test("hitl=1 escalates regardless of evidence", () => {
  const r = classifyFailed({ ...base, hitl: 1, evidence_md: "test failure only" }, []);
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons[0]).toContain("hitl=1");
});

test("class=trust escalates", () => {
  const r = classifyFailed({ ...base, class: "trust" }, []);
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons[0]).toContain("trust");
});

test("high-risk phrase in body escalates", () => {
  const r = classifyFailed({ ...base, body_md: "this might cause data loss" }, []);
  expect(r.verdict).toBe("needs-HITL");
  expect(r.reasons[0]).toContain("data loss");
});

test("high-risk phrase in evidence escalates", () => {
  const r = classifyFailed({ ...base, evidence_md: "dropped credentials by accident" }, []);
  expect(r.verdict).toBe("needs-HITL");
});

test("low-risk title hint classifies as low-risk", () => {
  const r = classifyFailed({ ...base, title: "benchmark coverage audit" }, []);
  expect(r.verdict).toBe("low-risk");
});

test("budget-blocked event classifies as low-risk", () => {
  const r = classifyFailed(base, [{ kind: "budget-blocked", payload_md: "out of tokens" }]);
  expect(r.verdict).toBe("low-risk");
});

test("test-only evidence classifies as low-risk", () => {
  const r = classifyFailed({ ...base, evidence_md: "unit test failed but feature works" }, []);
  expect(r.verdict).toBe("low-risk");
});

test("no signal → conservative HITL", () => {
  const r = classifyFailed({ ...base, title: "fix the auth flow", body_md: "rework login" }, []);
  expect(r.verdict).toBe("needs-HITL");
});

import { describe, expect, test } from "bun:test";
import { classifyStalePr, type PrRecord } from "./stale-pr-classifier";

const base: PrRecord = {
  draft: true,
  ageDays: 20,
  gateState: "clean",
  headBranchExists: true,
};

describe("classifyStalePr", () => {
  test("dead-by-worktree: draft, old, branch gone -> close", () => {
    expect(classifyStalePr({ ...base, headBranchExists: false })).toBe("close");
  });

  test("dead-by-red-gate: draft, old, gate red -> close", () => {
    expect(classifyStalePr({ ...base, gateState: "red" })).toBe("close");
  });

  test("clean-but-old: draft, old, clean gate, branch exists -> escalate", () => {
    expect(classifyStalePr(base)).toBe("escalate");
  });

  test("young draft: under threshold -> keep", () => {
    expect(classifyStalePr({ ...base, ageDays: 3 })).toBe("keep");
  });

  test("non-draft: not a draft regardless of age/gate -> keep", () => {
    expect(
      classifyStalePr({ ...base, draft: false, gateState: "red", headBranchExists: false }),
    ).toBe("keep");
  });

  test("threshold is configurable", () => {
    expect(classifyStalePr({ ...base, ageDays: 5 }, 3)).toBe("escalate");
  });
});

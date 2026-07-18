import { test, expect } from "bun:test";
import { routeProjectFromBody } from "./hygiene-project-route";

test("routes a src/ledger path to arc-agents", () => {
  expect(routeProjectFromBody("fix in src/ledger/merge-truth.ts")).toBe("arc-agents");
});

test("routes bin/ledger.ts to arc-agents", () => {
  expect(routeProjectFromBody("the bug is in bin/ledger.ts near hygiene-emit")).toBe("arc-agents");
});

test("routes a repo-prefixed shared path (arc-agents/src/ledger/x.ts)", () => {
  expect(routeProjectFromBody("touch arc-agents/src/ledger/claim.ts")).toBe("arc-agents");
});

test("routes a leading-./ path", () => {
  expect(routeProjectFromBody("./src/profiles/load.ts drifted")).toBe("arc-agents");
});

test("returns null when body names no shared-source path", () => {
  expect(routeProjectFromBody("update the README and CHOICES.md wording")).toBeNull();
});

test("routes a skills/ SKILL.md path to arc-agents", () => {
  expect(routeProjectFromBody("edit skills/foo/SKILL.md in arc-skills")).toBe("arc-agents");
});

test("returns null for a non-shared source file", () => {
  expect(routeProjectFromBody("update the CHANGELOG.md wording")).toBeNull();
});

test("returns null for empty/undefined body", () => {
  expect(routeProjectFromBody("")).toBeNull();
  expect(routeProjectFromBody(null)).toBeNull();
  expect(routeProjectFromBody(undefined)).toBeNull();
});

test("the observed regression: arc-skills task, arc-agents src file", () => {
  const body =
    "Worker needed to edit src/ledger/merge-truth.ts which lives in " +
    "arc-agents, but the row was project=arc-skills.";
  expect(routeProjectFromBody(body)).toBe("arc-agents");
});

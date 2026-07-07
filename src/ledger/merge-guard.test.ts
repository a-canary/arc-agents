// Tests for the merge guard (analysis-1780502957.md Pattern 1, Part A).
// Pure functions over (project, pr_url) — no db access, fixtures inline.

import { test, expect } from "bun:test";
import { checkMergeGuard, parsePrRepo, PROJECT_GH_REPO } from "./merge-guard";

// Fixture: a row that mirrors the broken cli-proxy OSS-readiness pattern —
// project=cli-proxy but pr_url points at a-canary/arc-agents/pull/197.
// Captured in analyse-recent-sessions 000031 (cli-proxy, 2026-06-03).
const CLI_PROXY_WRONG_REPO_ROW = {
  project: "cli-proxy",
  pr_url: "https://github.com/a-canary/arc-agents/pull/197",
};

test("parsePrRepo: accepts https://github.com/<owner>/<repo>/pull/<n>", () => {
  expect(parsePrRepo("https://github.com/a-canary/cli-proxy/pull/42")).toBe("a-canary/cli-proxy");
  expect(parsePrRepo("https://github.com/a-canary/arc-agents/pull/197")).toBe("a-canary/arc-agents");
});

test("parsePrRepo: accepts bare <owner>/<repo>/pull/<n> (gh CLI form)", () => {
  expect(parsePrRepo("a-canary/cli-proxy/pull/1")).toBe("a-canary/cli-proxy");
});

test("parsePrRepo: returns null for non-PR urls and null/empty input", () => {
  expect(parsePrRepo(null)).toBeNull();
  expect(parsePrRepo(undefined)).toBeNull();
  expect(parsePrRepo("")).toBeNull();
  expect(parsePrRepo("https://github.com/a-canary/arc-agents")).toBeNull(); // no /pull/<n>
  expect(parsePrRepo("not a url")).toBeNull();
});

test("checkMergeGuard: refuses project=cli-proxy with pr_url pointing at arc-agents (the bug from 000031)", () => {
  const refusal = checkMergeGuard(CLI_PROXY_WRONG_REPO_ROW.project, CLI_PROXY_WRONG_REPO_ROW.pr_url);
  expect(refusal).not.toBeNull();
  // Acceptance: error names both the expected and actual repos.
  expect(refusal).toContain("a-canary/cli-proxy"); // expected
  expect(refusal).toContain("a-canary/arc-agents"); // actual
  expect(refusal).toContain("cli-proxy"); // the project's own name
  expect(refusal).toContain("merged"); // a worker can grep for the reason
});

// Hygiene followup clarify-docs-bin-ledger-ts-update-refuse:
// the cross-project convention (e.g. ke hygiene rows filed in the
// arc-agents ledger but PR'd to a-canary/ke) is a legitimate use of
// --in-place. The refusal message must point workers there so they
// don't escalate via HITL when the right answer is the in-place flag.
test("checkMergeGuard: refusal mentions --in-place as a valid escape (cross-project convention)", () => {
  const refusal = checkMergeGuard("arc-agents", "https://github.com/a-canary/ke/pull/62");
  expect(refusal).not.toBeNull();
  expect(refusal).toContain("--in-place");
});

test("checkMergeGuard: accepts project=cli-proxy with pr_url at a-canary/cli-proxy", () => {
  expect(checkMergeGuard("cli-proxy", "https://github.com/a-canary/cli-proxy/pull/1")).toBeNull();
  expect(checkMergeGuard("cli-proxy", "a-canary/cli-proxy/pull/1")).toBeNull();
});

// Hygiene followup clarify-docs-ledger-merge-gate-alias-map:
// local dir is `starlight-slm` (lowercase); github repo is `Starlight-SLM`
// (capital S-L-M). Before this alias was added, the merge guard short-
// circuited and let PRs slip through; workers had to use --in-place to
// close merged rows. Verified 2026-07-07 from PRs #8 + #19.
test("checkMergeGuard: accepts project=starlight-slm with pr_url at a-canary/Starlight-SLM (capital S-L-M)", () => {
  expect(checkMergeGuard("starlight-slm", "https://github.com/a-canary/Starlight-SLM/pull/19")).toBeNull();
  expect(checkMergeGuard("starlight-slm", "a-canary/Starlight-SLM/pull/8")).toBeNull();
});

test("checkMergeGuard: refuses project=starlight-slm with pr_url pointing at a-canary/starlight-slm (lowercase, the bug)", () => {
  const refusal = checkMergeGuard("starlight-slm", "https://github.com/a-canary/starlight-slm/pull/19");
  expect(refusal).not.toBeNull();
  expect(refusal).toContain("a-canary/Starlight-SLM"); // expected (capital)
  expect(refusal).toContain("a-canary/starlight-slm"); // actual (lowercase)
});

test("checkMergeGuard: accepts all known project→repo mappings", () => {
  for (const [project, repo] of Object.entries(PROJECT_GH_REPO)) {
    const n = Math.floor(Math.random() * 1000) + 1;
    expect(checkMergeGuard(project, `https://github.com/${repo}/pull/${n}`)).toBeNull();
  }
});

test("checkMergeGuard: short-circuits for unknown project, null project, unparseable pr_url", () => {
  expect(checkMergeGuard(null, "https://github.com/a-canary/arc-agents/pull/1")).toBeNull();
  expect(checkMergeGuard(undefined, "https://github.com/a-canary/arc-agents/pull/1")).toBeNull();
  expect(checkMergeGuard("brand-new-project", "https://github.com/a-canary/brand-new-project/pull/1")).toBeNull();
  expect(checkMergeGuard("cli-proxy", null)).toBeNull();
  expect(checkMergeGuard("cli-proxy", "not a url")).toBeNull();
});

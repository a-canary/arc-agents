// Part A of analysis-1780502957.md (Pattern 1): when a worker files
// `update --state=merged --pr <url>`, the row's `project` field must
// match the github repo parsed from the pr_url. This stops the
// 6-of-7 cli-proxy OSS-readiness rows from being marked merged with
// pr_url fields pointing at a-canary/arc-agents instead of
// a-canary/cli-proxy (work landed in the wrong repo, origin/main for
// a-canary/cli-proxy is missing all 7 deliverables).
//
// The mapping is explicit and small — extend PROJECT_GH_REPO when a
// new project is onboarded. Unknown projects are not rejected here:
// the row's project field is the source of truth and we have no
// canonical mapping for it, so the guard short-circuits and the
// merge proceeds (a missing entry is a documentation gap, not a
// safety check failure).

export const PROJECT_GH_REPO: Readonly<Record<string, string>> = {
  "arc-agents": "a-canary/arc-agents",
  "cli-proxy": "a-canary/cli-proxy",
  ke: "a-canary/ke",
  bitnet: "a-canary/bitnet",
  // Local dir is `starlight-slm` (lowercase); github repo is `Starlight-SLM`
  // (capital S-L-M). Without this entry, the merge guard short-circuits
  // (unknown project = skip), letting wrong-repo PRs slip through.
  // Verified 2026-07-07 from PRs #8 + #19 (both to a-canary/Starlight-SLM).
  "starlight-slm": "a-canary/Starlight-SLM",
  "llm-judge": "a-canary/llm-judge",
  // Local dir is `conjecture` (lowercase); github repo is `Conjecture` (capital C).
  // Without this entry, the merge guard short-circuits (unknown project = skip),
  // letting wrong-repo PRs slip through. Verified 2026-06-30 from PR #19.
  conjecture: "a-canary/Conjecture",
  // Local dir is `trading` (lowercase); github repo is `Trading` (capital T).
  // Without this entry, the merge guard short-circuits (unknown project = skip),
  // letting wrong-repo PRs slip through. Verified 2026-07-11 from PR #166
  // (a-canary/Trading).
  trading: "a-canary/Trading",
};

// Parses a pr_url into "owner/repo", accepting the github.com form
// (https://github.com/a-canary/arc-agents/pull/197) and the bare
// owner/repo form (a-canary/arc-agents/pull/197). Returns null when
// the URL doesn't look like a PR URL — the caller treats that as a
// guard short-circuit (not a mismatch).
export function parsePrRepo(prUrl: string | null | undefined): string | null {
  if (!prUrl) return null;
  // Strip protocol + host if present.
  const stripped = prUrl.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
  const m = stripped.match(/^([^/\s]+)\/([^/\s]+)\/pull\/\d+/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

// Returns null when the merge is allowed, or a human-readable refusal
// string naming both the expected and actual repos when the guard
// fires. project=null/undefined short-circuits (legacy rows from
// before project was populated).
export function checkMergeGuard(
  project: string | null | undefined,
  prUrl: string | null | undefined,
): string | null {
  if (!project) return null;
  const expected = PROJECT_GH_REPO[project];
  if (!expected) return null; // unknown project — skip guard
  const actual = parsePrRepo(prUrl);
  if (actual === null) return null; // unparseable pr_url — skip guard
  if (actual === expected) return null;
  return (
    `refuse merged: row project='${project}' expects PR at ${expected}, ` +
    `but pr_url='${prUrl}' resolves to ${actual}. ` +
    // Cross-project convention (e.g. ke hygiene rows filed in the
    // arc-agents ledger but PR'd to a-canary/ke) is a legitimate use of
    // --in-place: workers must be told the flag is a valid escape, not
    // just the HITL escalation path. Escalate via HITL only when
    // --in-place doesn't fit. Hygiene: clarify-docs-bin-ledger-ts-update-refuse.
    `Re-target the PR to ${expected}, ` +
    `or use --in-place with --evidence if this is a cross-project convention, ` +
    `or escalate via HITL for project reassignment.`
  );
}

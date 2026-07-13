// Part A of analysis-1780502957.md (Pattern 1): when a worker files
// `update --state=merged --pr <url>`, the row's `project` field must
// match the github repo parsed from the pr_url. This stops the
// 6-of-7 cli-proxy OSS-readiness rows from being marked merged with
// pr_url fields pointing at a-canary/arc-agents instead of
// a-canary/cli-proxy (work landed in the wrong repo, origin/main for
// a-canary/cli-proxy is missing all 7 deliverables).
//
// The mapping is explicit and small — extend PROJECT_GH_REPO when a
// new project is onboarded. On the PR merge route the guard now fails
// CLOSED: an unknown project (non-null, no map entry) or a present-but-
// unparseable pr_url refuses the merge rather than short-circuiting.
// The only remaining short-circuits are structural: a null/undefined
// project (legacy rows written before `project` was populated) and a
// null pr_url (not a PR-route merge at all — in-place / local-sha
// routes carry their own verification).

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
  // Local project is `arc-webui`; github repo is `webui` (verified 2026-06-26
  // from issues.pr_url, 17 PRs dominant — see CLAUDE.md alias table). Absence
  // here let the motivating cross-repo-gate incident (row targeting
  // a-canary/webui) slip through both the merge guard and the claim gate.
  "arc-webui": "a-canary/webui",
  "webui-specs": "a-canary/webui-specs",
  "arc-skills": "a-canary/arc-skills",
  pipeliner: "a-canary/pipeliner",
  "discord-bridge": "a-canary/discord-bridge",
  // Local project is `onenation`; github repo is `OurNation` (verified
  // 2026-08-04 from origin remote + PR #227).
  onenation: "a-canary/OurNation",
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
// string when the guard fires. Fail-closed on the PR route:
//   - project=null/undefined → short-circuit (legacy rows, no mapping)
//   - pr_url=null/undefined  → short-circuit (not a PR-route merge)
//   - unknown project + PR url → refuse (extend PROJECT_GH_REPO)
//   - present-but-unparseable pr_url → refuse
//   - repo mismatch → refuse (names expected + actual)
export function checkMergeGuard(
  project: string | null | undefined,
  prUrl: string | null | undefined,
): string | null {
  if (!project) return null;
  // No pr_url this invocation → not a PR-route merge; nothing to guard.
  if (!prUrl) return null;
  const expected = PROJECT_GH_REPO[project];
  if (!expected) {
    return (
      `refuse merged: row project='${project}' has no PROJECT_GH_REPO mapping, ` +
      `so the PR route cannot verify pr_url='${prUrl}' targets the right repo. ` +
      `Add '${project}' to PROJECT_GH_REPO in src/ledger/merge-guard.ts, ` +
      `or use --in-place with --evidence if this is a genuine cross-project convention.`
    );
  }
  const actual = parsePrRepo(prUrl);
  if (actual === null) {
    return (
      `refuse merged: pr_url='${prUrl}' is unparseable (expected .../pull/<n>), ` +
      `so the PR route cannot verify it targets ${expected}. ` +
      `Fix pr_url to a full GitHub PR URL, or use --in-place with --evidence.`
    );
  }
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

// Projects where only the operator may land code: workers open a draft PR
// and Aaron submits/merges (USER.md "Non-owned public PRs"). On these repos
// an --in-place merge assertion can only be wrong — the worker cannot have
// merged anything, so the ledger-says-merged/GH-says-open desync is
// guaranteed (conjecture PR #28, analysis-1784455208 Pattern 1). Extend
// when a new human-merge-only project is onboarded.
export const NON_OWNED_PROJECTS: ReadonlySet<string> = new Set(["conjecture"]);

// Returns null when the in-place merge is allowed, or a refusal string.
// force (--force-in-place) is the explicit operator escape hatch.
export function checkInPlaceGuard(
  project: string | null | undefined,
  inPlace: boolean,
  force: boolean,
): string | null {
  if (!inPlace || force || !project || !NON_OWNED_PROJECTS.has(project)) return null;
  return (
    `refuse merged: --in-place is not valid for project='${project}' — it is a ` +
    `non-owned public repo where workers open draft PRs and only the operator ` +
    `merges (USER.md). An in-place assertion here guarantees a ledger/GitHub ` +
    `desync (see conjecture PR #28). File a draft PR and park the row in ` +
    `state=review, or pass --force-in-place if you are the operator asserting ` +
    `a merge that really happened outside GitHub.`
  );
}

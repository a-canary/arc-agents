// hygiene-project-route.ts — route a hygiene followup to the repo that owns
// the file it must edit, not the repo of the task that observed it.
//
// Root cause (improve-architecture-route-hygiene-emit-): hygiene-emit inherits
// `project` from --observed-in-task. But arc-skills / webui-specs / arc-agents
// all touch the SAME shared source surface (bin/ledger.ts, src/ledger/*). An
// improve-architecture row observed in an arc-skills task, whose fix lives in
// src/ledger/merge-truth.ts, wrongly gets project=arc-skills — then bookie's
// merge guard refuses the PR (filed against a-canary/arc-agents) as a mismatch.
//
// A file path only ever lives in one repo. When the followup body names such a
// path, that path's home repo is the correct attribution — it beats the
// observed-task project because the fix physically cannot land anywhere else.
//
// Kept minimal: only the confirmed shared-source surface (the arc-agents
// ledger/factory/profiles code that arc-skills + webui-specs workers reach
// into). Extend SHARED_SOURCE_PREFIXES when a new cross-repo shared surface
// appears; unknown paths return null (no routing, existing precedence holds).

/** path-prefix → owning repo (ledger `project` value). Longest match wins. */
const SHARED_SOURCE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["bin/ledger.ts", "arc-agents"],
  ["bin/factory.ts", "arc-agents"],
  ["bin/arc-chat.ts", "arc-agents"],
  ["bin/hygiene-tick.ts", "arc-agents"],
  ["bin/worker-shell.sh", "arc-agents"],
  ["bin/wait-for-ledger", "arc-agents"],
  ["src/ledger/", "arc-agents"],
  ["src/profiles/", "arc-agents"],
  ["skills/", "arc-agents"],
];

// Match file-path-shaped tokens: word chars, slashes, dots, dashes ending in
// a recognised source extension or a trailing slash dir reference. We only
// need enough to find shared-source paths, not to validate arbitrary paths.
const PATH_TOKEN = /[\w./-]*\.(?:ts|tsx|js|sh|json|md)\b|[\w./-]*src\/ledger\/[\w./-]*|[\w./-]*src\/profiles\/[\w./-]*/g;

/**
 * Inspect a hygiene followup body for a file path that lives in a known
 * shared-source repo. Returns that repo's ledger `project` value, or null when
 * the body names no shared-source path (callers keep their existing project
 * precedence: explicit --project > observed-task > default).
 *
 * When multiple shared-source paths appear they all resolve to the same repo
 * today (all arc-agents); if a future body mixes repos, the first match wins —
 * a followup touching two repos is not atomic and should be split anyway.
 */
export function routeProjectFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const tokens = body.match(PATH_TOKEN);
  if (!tokens) return null;
  for (const raw of tokens) {
    // Normalise a leading ./ and any repo-dir prefix noise; we match on the
    // suffix so `arc-agents/src/ledger/x.ts` and `src/ledger/x.ts` both hit.
    const tok = raw.replace(/^\.\//, "");
    for (const [prefix, repo] of SHARED_SOURCE_PREFIXES) {
      if (tok === prefix || tok.includes(prefix)) return repo;
    }
  }
  return null;
}

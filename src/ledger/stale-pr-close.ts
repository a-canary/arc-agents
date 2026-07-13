// Auto-close path for dead draft PRs: comment-with-evidence, then close.
// Never deletes the branch. `gh` calls go through `run` so callers can stub
// it at the command boundary in tests (per parent PRD Testing Decisions).
//
// Scope: this module only acts on a PR already identified as dead by the
// caller (see sibling task pure-stale-pr-classifier-given-pr-record for the
// keep/close/escalate decision itself). Idempotent: skips the close if the
// PR is already closed.

export type StalePrEvidence = {
  ageDays: number;
  worktreeGone: boolean;
  redGate: boolean;
};

export type StalePr = {
  repo: string; // "owner/name"
  number: number;
  isOpen: boolean;
};

export type RunGh = (args: string[]) => { ok: boolean; stdout: string };

export const DEFAULT_STALE_DRAFT_DAYS = 14;

// Reads the `staleDraftDays` knob from a parsed hygiene.yaml (see
// bin/hygiene-tick.ts config doc comment). Accepts either a flat number
// (applies to all repos) or a per-repo map; falls back to the default.
export function readStaleDraftDays(cfg: unknown, repo: string): number {
  const raw = (cfg as Record<string, unknown> | null | undefined)?.staleDraftDays;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (raw && typeof raw === "object") {
    const perRepo = (raw as Record<string, unknown>)[repo];
    if (typeof perRepo === "number" && Number.isFinite(perRepo) && perRepo > 0) return perRepo;
  }
  return DEFAULT_STALE_DRAFT_DAYS;
}

export function evidenceComment(ev: StalePrEvidence): string {
  const reasons: string[] = [`open ${ev.ageDays}d (threshold met)`];
  if (ev.worktreeGone) reasons.push("worktree no longer exists");
  if (ev.redGate) reasons.push("merge gate is red");
  return (
    `Auto-closing this stale draft:\n` +
    reasons.map((r) => `- ${r}`).join("\n") +
    `\n\nBranch is left intact; reopen if this is still active.`
  );
}

// Returns what it did so callers/tests can assert without re-parsing gh args.
export function closeStaleDraft(
  pr: StalePr,
  evidence: StalePrEvidence,
  run: RunGh,
): { commented: boolean; closed: boolean } {
  if (!pr.isOpen) return { commented: false, closed: false };

  const commentResult = run([
    "pr",
    "comment",
    String(pr.number),
    "--repo",
    pr.repo,
    "--body",
    evidenceComment(evidence),
  ]);
  if (!commentResult.ok) return { commented: false, closed: false };

  const closeResult = run(["pr", "close", String(pr.number), "--repo", pr.repo]);
  return { commented: true, closed: closeResult.ok };
}

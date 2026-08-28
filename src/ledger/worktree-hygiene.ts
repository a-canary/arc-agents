// Pure worktree-hygiene classifier. No fs/git/db — the collector
// (bin/worktree-hygiene.ts) gathers facts, this module decides the action
// class, and the writer files a ticket per non-null verdict.
//
// Action classes (first match wins):
//   cleanup — prunable worktree, or abandoned (old + no live row)
//   commit  — uncommitted work on a live row
//   finish  — unpushed commits on a live row
//   review  — residue (dirty or unpushed) without a live row — human call
//   null    — healthy, no ticket

export type WorktreeFacts = {
  prunable: boolean;
  dirtyFiles: number;
  unpushedCommits: number;
  lastCommitAgeDays: number;
  branch: string;
  linkedRowState: "live" | "terminal" | "none";
  abandonDays: number;
};

export type WorktreeAction = "commit" | "finish" | "review" | "cleanup";

export type WorktreeVerdict = {
  action: WorktreeAction;
  reason: string;
};

export function classifyWorktree(f: WorktreeFacts): WorktreeVerdict | null {
  if (f.prunable) {
    return { action: "cleanup", reason: "prunable: worktree dir missing/invalid (git worktree prune candidate)" };
  }
  if (f.dirtyFiles > 0 && f.linkedRowState === "live") {
    return { action: "commit", reason: `${f.dirtyFiles} uncommitted file(s) on a live row` };
  }
  if (f.unpushedCommits > 0 && f.linkedRowState === "live") {
    return { action: "finish", reason: `${f.unpushedCommits} unpushed commit(s) on a live row` };
  }
  if (f.lastCommitAgeDays >= f.abandonDays && f.linkedRowState !== "live") {
    return {
      action: "cleanup",
      reason: `abandoned: last commit ${f.lastCommitAgeDays}d ago (>= ${f.abandonDays}d), linked row ${f.linkedRowState}`,
    };
  }
  if (f.dirtyFiles > 0 || f.unpushedCommits > 0) {
    return { action: "review", reason: "residue (dirty or unpushed) without a live row — human call" };
  }
  return null;
}

// Suggested operator command per action class. Never executed by the driver —
// it is embedded in the ticket body for whoever picks the ticket up.
export function suggestedCommand(action: WorktreeAction, path: string, prunable: boolean): string {
  switch (action) {
    case "cleanup":
      return prunable ? `git worktree prune` : `git worktree remove --force ${path}`;
    case "finish":
      return "git push";
    case "commit":
      return "git commit";
    case "review":
      return ""; // human call — no suggested command
  }
}

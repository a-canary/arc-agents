import { describe, expect, test } from "bun:test";
import { classifyWorktree, suggestedCommand, type WorktreeAction, type WorktreeFacts } from "./worktree-hygiene";

const base: WorktreeFacts = {
  prunable: false,
  dirtyFiles: 0,
  unpushedCommits: 0,
  lastCommitAgeDays: 1,
  branch: "worker/foo",
  linkedRowState: "none",
  abandonDays: 14,
  headReachable: true,
  worktreeAgeDays: 30,
};

// Table-driven: one case per rule, plus priority and healthy→null.
const cases: Array<{ name: string; facts: WorktreeFacts; want: WorktreeAction | null }> = [
  { name: "prunable → cleanup", facts: { ...base, prunable: true }, want: "cleanup" },
  { name: "dirty + live → commit", facts: { ...base, dirtyFiles: 3, linkedRowState: "live" }, want: "commit" },
  { name: "unpushed + live → finish", facts: { ...base, unpushedCommits: 2, linkedRowState: "live" }, want: "finish" },
  {
    name: "old + non-live → cleanup (abandoned)",
    facts: { ...base, lastCommitAgeDays: 30, linkedRowState: "terminal" },
    want: "cleanup",
  },
  {
    name: "old + none → cleanup (abandoned)",
    facts: { ...base, lastCommitAgeDays: 14, linkedRowState: "none" },
    want: "cleanup",
  },
  { name: "dirty + none → review", facts: { ...base, dirtyFiles: 1 }, want: "review" },
  { name: "unpushed + terminal → review", facts: { ...base, unpushedCommits: 1, linkedRowState: "terminal" }, want: "review" },
  {
    name: "prunable beats everything (dirty + live + prunable)",
    facts: { ...base, prunable: true, dirtyFiles: 5, linkedRowState: "live" },
    want: "cleanup",
  },
  {
    name: "commit beats finish (dirty + unpushed + live)",
    facts: { ...base, dirtyFiles: 2, unpushedCommits: 2, linkedRowState: "live" },
    want: "commit",
  },
  {
    name: "commit beats abandoned (dirty + old + live)",
    facts: { ...base, dirtyFiles: 1, lastCommitAgeDays: 99, linkedRowState: "live" },
    want: "commit",
  },
  {
    name: "fresh + non-live + no residue → null (healthy)",
    facts: { ...base, lastCommitAgeDays: 2, linkedRowState: "terminal" },
    want: null,
  },
  { name: "fully clean, no row → null (healthy)", facts: { ...base }, want: null },
];

describe("classifyWorktree", () => {
  for (const c of cases) {
    test(c.name, () => {
      const v = classifyWorktree(c.facts);
      if (c.want === null) {
        expect(v).toBeNull();
      } else {
        expect(v?.action).toBe(c.want);
        expect(v?.reason.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("suggestedCommand", () => {
  test("cleanup → prune when prunable, remove --force otherwise", () => {
    expect(suggestedCommand("cleanup", "/w/x", true)).toBe("git worktree prune");
    expect(suggestedCommand("cleanup", "/w/x", false)).toBe("git worktree remove --force /w/x");
  });
  test("finish → push, commit → commit, review → none", () => {
    expect(suggestedCommand("finish", "/w/x", false)).toBe("git push");
    expect(suggestedCommand("commit", "/w/x", false)).toBe("git commit");
    expect(suggestedCommand("review", "/w/x", false)).toBe("");
  });

  // Regression: arc-webui mission-inversion. A detached worktree whose HEAD was
  // on no branch got a bare `remove --force`; running it verbatim would have
  // orphaned 1516 lines of unique work.
  test("cleanup with unreachable HEAD → archives before removing, never bare --force", () => {
    const cmd = suggestedCommand("cleanup", "/w/mission-inversion", false, false);
    expect(cmd).toContain("tag archive/mission-inversion HEAD");
    expect(cmd.indexOf("tag")).toBeLessThan(cmd.indexOf("worktree remove"));
    expect(cmd).not.toMatch(/^git worktree remove/);
  });

  test("prunable wins over unreachable HEAD — dir is gone, nothing to archive", () => {
    expect(suggestedCommand("cleanup", "/w/x", true, false)).toBe("git worktree prune");
  });
});

describe("classifyWorktree reachability", () => {
  const abandoned = { ...base, lastCommitAgeDays: 30, linkedRowState: "none" as const };

  test("unreachable HEAD → cleanup reason warns before the operator acts", () => {
    const v = classifyWorktree({ ...abandoned, headReachable: false });
    expect(v?.action).toBe("cleanup");
    expect(v?.reason).toContain("archive before removing");
  });

  test("reachable HEAD → no orphan warning (no crying wolf)", () => {
    const v = classifyWorktree({ ...abandoned, headReachable: true });
    expect(v?.action).toBe("cleanup");
    expect(v?.reason).not.toContain("archive before removing");
  });
});

// Regression: the abandonment gate must measure the age of the WORKTREE, not the
// age of its HEAD commit. A worker that branches off main and makes zero commits
// inherits main's tip date, so on a repo with a stale main every fresh worktree
// scored as "abandoned 54d ago" minutes after creation — the hygiene sweep then
// filed cleanup tickets against worktrees that were still in use, including its
// own. See docs analysis 2026-09-11 (48% of lifetime cleanup rows were self-made).
describe("abandonment gates on worktree age, not HEAD-commit age", () => {
  // pipeliner's real numbers: main tip 54d old, worktree created this morning.
  const freshOnStaleMain: WorktreeFacts = {
    ...base,
    lastCommitAgeDays: 54,
    worktreeAgeDays: 0,
    linkedRowState: "none",
  };

  test("fresh worktree on a stale-main repo is not abandoned", () => {
    expect(classifyWorktree(freshOnStaleMain)).toBeNull();
  });

  test("still abandoned once the directory itself ages past the gate", () => {
    const v = classifyWorktree({ ...freshOnStaleMain, worktreeAgeDays: 20 });
    expect(v?.action).toBe("cleanup");
  });

  test("a young worktree is never reaped no matter how old HEAD is", () => {
    for (const headAge of [14, 54, 365]) {
      expect(classifyWorktree({ ...freshOnStaleMain, lastCommitAgeDays: headAge })).toBeNull();
    }
  });

  // Both clocks must pass: an old directory whose HEAD is recent means someone
  // committed to it lately, so it is live work regardless of directory age.
  test("old directory with a recent commit is not abandoned", () => {
    const v = classifyWorktree({ ...base, worktreeAgeDays: 90, lastCommitAgeDays: 1, linkedRowState: "none" });
    expect(v).toBeNull();
  });

  test("a live row still wins over both clocks", () => {
    const v = classifyWorktree({ ...base, worktreeAgeDays: 90, lastCommitAgeDays: 90, linkedRowState: "live" });
    expect(v).toBeNull();
  });
});

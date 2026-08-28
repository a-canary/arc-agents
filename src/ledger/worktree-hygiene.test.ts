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
});

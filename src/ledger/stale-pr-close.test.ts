import { describe, expect, test } from "bun:test";
import {
  closeStaleDraft,
  evidenceComment,
  readStaleDraftDays,
  DEFAULT_STALE_DRAFT_DAYS,
  type RunGh,
} from "./stale-pr-close";

function fakeRun(calls: string[][]): RunGh {
  return (args) => {
    calls.push(args);
    return { ok: true, stdout: "" };
  };
}

describe("evidenceComment", () => {
  test("cites age, worktree-gone, and red-gate evidence", () => {
    const body = evidenceComment({ ageDays: 20, worktreeGone: true, redGate: true });
    expect(body).toContain("20d");
    expect(body).toContain("worktree no longer exists");
    expect(body).toContain("merge gate is red");
  });

  test("omits reasons not present", () => {
    const body = evidenceComment({ ageDays: 15, worktreeGone: true, redGate: false });
    expect(body).not.toContain("merge gate is red");
  });
});

describe("closeStaleDraft", () => {
  test("comments then closes an open PR, never touching the branch", () => {
    const calls: string[][] = [];
    const result = closeStaleDraft(
      { repo: "acme/widgets", number: 42, isOpen: true },
      { ageDays: 14, worktreeGone: true, redGate: false },
      fakeRun(calls),
    );
    expect(result).toEqual({ commented: true, closed: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "pr",
      "comment",
      "42",
      "--repo",
      "acme/widgets",
      "--body",
      evidenceComment({ ageDays: 14, worktreeGone: true, redGate: false }),
    ]);
    expect(calls[1]).toEqual(["pr", "close", "42", "--repo", "acme/widgets"]);
    expect(calls.some((c) => c.includes("branch"))).toBe(false);
    expect(calls.flat().some((a) => a.includes("delete"))).toBe(false);
  });

  test("is idempotent: skips already-closed PRs", () => {
    const calls: string[][] = [];
    const result = closeStaleDraft(
      { repo: "acme/widgets", number: 42, isOpen: false },
      { ageDays: 30, worktreeGone: false, redGate: true },
      fakeRun(calls),
    );
    expect(result).toEqual({ commented: false, closed: false });
    expect(calls).toHaveLength(0);
  });

  test("does not close if the comment fails", () => {
    const calls: string[][] = [];
    const run: RunGh = (args) => {
      calls.push(args);
      return { ok: false, stdout: "" };
    };
    const result = closeStaleDraft(
      { repo: "acme/widgets", number: 7, isOpen: true },
      { ageDays: 14, worktreeGone: true, redGate: false },
      run,
    );
    expect(result).toEqual({ commented: false, closed: false });
    expect(calls).toHaveLength(1);
  });
});

describe("readStaleDraftDays", () => {
  test("defaults to 14 when unset", () => {
    expect(readStaleDraftDays({}, "arc-agents")).toBe(DEFAULT_STALE_DRAFT_DAYS);
    expect(readStaleDraftDays(undefined, "arc-agents")).toBe(DEFAULT_STALE_DRAFT_DAYS);
  });

  test("flat number applies to all repos", () => {
    expect(readStaleDraftDays({ staleDraftDays: 21 }, "arc-agents")).toBe(21);
  });

  test("per-repo map overrides the default for a matching repo", () => {
    const cfg = { staleDraftDays: { "arc-agents": 7 } };
    expect(readStaleDraftDays(cfg, "arc-agents")).toBe(7);
    expect(readStaleDraftDays(cfg, "other-repo")).toBe(DEFAULT_STALE_DRAFT_DAYS);
  });

  test("ignores invalid values", () => {
    expect(readStaleDraftDays({ staleDraftDays: -5 }, "arc-agents")).toBe(DEFAULT_STALE_DRAFT_DAYS);
    expect(readStaleDraftDays({ staleDraftDays: "two weeks" }, "arc-agents")).toBe(
      DEFAULT_STALE_DRAFT_DAYS,
    );
  });
});

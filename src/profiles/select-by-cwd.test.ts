import { test, expect, describe } from "bun:test";
import { selectRoleByCwd, directorGroupFromCwd, type Role } from "./select-by-cwd";

const HOME = "/home/u";

const cases: Array<{ name: string; cwd: string; expect: Role }> = [
  { name: "admin root", cwd: `${HOME}/vault/agents/admin`, expect: "admin" },
  { name: "admin nested", cwd: `${HOME}/vault/agents/admin/inbox`, expect: "admin" },
  { name: "admin trailing slash", cwd: `${HOME}/vault/agents/admin/`, expect: "admin" },
  { name: "director root", cwd: `${HOME}/vault/agents/director`, expect: "director" },
  { name: "director nested", cwd: `${HOME}/vault/agents/director/journal`, expect: "director" },
  { name: "worktree repo-slug", cwd: `${HOME}/worktrees/arc-agents-foo`, expect: "developer" },
  { name: "worktree nested", cwd: `${HOME}/worktrees/arc-agents-foo/src`, expect: "developer" },
  { name: "repos top-level", cwd: `${HOME}/repos/arc-agents`, expect: "developer" },
  { name: "repos nested", cwd: `${HOME}/repos/arc-agents/src`, expect: "developer" },
  { name: "fallback /tmp", cwd: "/tmp", expect: "director" },
  { name: "fallback home root", cwd: HOME, expect: "director" },
  { name: "fallback vault but not agents", cwd: `${HOME}/vault/ke`, expect: "director" },
  { name: "fallback vault/agents/other", cwd: `${HOME}/vault/agents/other`, expect: "director" },
  { name: "directors plural group", cwd: `${HOME}/vault/agents/directors/onenation`, expect: "director" },
  { name: "directors plural group nested", cwd: `${HOME}/vault/agents/directors/onenation/journal`, expect: "director" },
  { name: "directors bare root", cwd: `${HOME}/vault/agents/directors`, expect: "director" },
];

describe("selectRoleByCwd (A-0003)", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(selectRoleByCwd(c.cwd, { home: HOME })).toBe(c.expect);
    });
  }

  test("admin precedence over director/worktree/repos", () => {
    expect(selectRoleByCwd(`${HOME}/vault/agents/admin/x`, { home: HOME })).toBe("admin");
  });

  test("prefix-collision: 'admins' is not 'admin'", () => {
    expect(selectRoleByCwd(`${HOME}/vault/agents/admins`, { home: HOME })).toBe("director");
  });

  test("prefix-collision: 'worktreesX' is not 'worktrees'", () => {
    expect(selectRoleByCwd(`${HOME}/worktreesX/foo`, { home: HOME })).toBe("director");
  });

  test("relative cwd resolved against process cwd then matched", () => {
    const r = selectRoleByCwd(".", { home: HOME });
    expect(["admin", "director", "developer"]).toContain(r);
  });

  test("uses os.homedir() when no override", () => {
    const r = selectRoleByCwd("/nonexistent/path");
    expect(r).toBe("director");
  });
});

describe("directorGroupFromCwd (A-0003)", () => {
  const groups: Array<{ name: string; cwd: string; expect: string | null }> = [
    { name: "group root", cwd: `${HOME}/vault/agents/directors/onenation`, expect: "onenation" },
    { name: "group nested deep", cwd: `${HOME}/vault/agents/directors/onenation/journal/x`, expect: "onenation" },
    { name: "group trailing slash", cwd: `${HOME}/vault/agents/directors/onenation/`, expect: "onenation" },
    { name: "bare directors root → null", cwd: `${HOME}/vault/agents/directors`, expect: null },
    { name: "admin path → null", cwd: `${HOME}/vault/agents/admin/inbox`, expect: null },
    { name: "singular director → null", cwd: `${HOME}/vault/agents/director/journal`, expect: null },
    { name: "repos path → null", cwd: `${HOME}/repos/arc-agents/src`, expect: null },
    { name: "/tmp → null", cwd: "/tmp", expect: null },
  ];
  for (const g of groups) {
    test(g.name, () => {
      expect(directorGroupFromCwd(g.cwd, { home: HOME })).toBe(g.expect);
    });
  }
});

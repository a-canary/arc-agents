import { test, expect, describe } from "bun:test";
import { selectRoleByCwd, type Role } from "./select-by-cwd";

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

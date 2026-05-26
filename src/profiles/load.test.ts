import { test, expect } from "bun:test";
import { loadAll, loadProfile } from "./load";

test("all 3 agent profiles validate", () => {
  const all = loadAll();
  expect(Object.keys(all).sort()).toEqual(["admin", "developer", "director"]);
  for (const agent of ["developer", "director", "admin"]) {
    expect(all[agent]!.agent).toBe(agent);
  }
});

test("each profile has a non-empty exec_cli_alias", () => {
  const all = loadAll();
  for (const agent of ["developer", "director", "admin"]) {
    expect(all[agent]!.exec_cli_alias.length).toBeGreaterThan(0);
  }
});

test("developer has worktree=true", () => {
  expect(loadProfile("developer").worktree).toBe(true);
});

test("director/admin have worktree=false", () => {
  expect(loadProfile("director").worktree).toBe(false);
  expect(loadProfile("admin").worktree).toBe(false);
});

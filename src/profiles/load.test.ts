import { test, expect } from "bun:test";
import { loadAll, loadProfile } from "./load";

test("all 3 role profiles validate", () => {
  const all = loadAll();
  expect(Object.keys(all).sort()).toEqual(["admin", "developer", "director"]);
  for (const role of ["developer", "director", "admin"]) {
    expect(all[role]!.role).toBe(role);
  }
});

test("developer has worktree=true", () => {
  expect(loadProfile("developer").worktree).toBe(true);
});

test("director/admin have worktree=false", () => {
  expect(loadProfile("director").worktree).toBe(false);
  expect(loadProfile("admin").worktree).toBe(false);
});

import { test, expect } from "bun:test";
import { loadAll, loadProfile } from "./load";

test("all 5 agent profiles validate (core 3)", () => {
  const all = loadAll();
  for (const agent of ["developer", "director", "admin"]) {
    expect(all[agent]!.agent).toBe(agent);
  }
});

test("each profile has a non-empty exec_cli_alias (core 3)", () => {
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

test("all 5 agent profiles validate (includes sprint and triage)", () => {
  const all = loadAll();
  expect(Object.keys(all).sort()).toEqual(["admin", "developer", "director", "sprint", "triage"]);
  for (const agent of ["developer", "director", "admin", "sprint", "triage"]) {
    expect(all[agent]!.agent).toBe(agent);
  }
});

test("each profile has a non-empty exec_cli_alias (all 5)", () => {
  const all = loadAll();
  for (const agent of ["developer", "director", "admin", "sprint", "triage"]) {
    expect(all[agent]!.exec_cli_alias.length).toBeGreaterThan(0);
  }
});

test("sprint profile: boot_skills contains sprint-supervise", () => {
  expect(loadProfile("sprint").boot_skills).toContain("sprint-supervise");
});

test("sprint profile: worktree=true", () => {
  expect(loadProfile("sprint").worktree).toBe(true);
});

test("triage profile: exec_cli_alias === minimax-build", () => {
  expect(loadProfile("triage").exec_cli_alias).toBe("minimax-build");
});

// render-prompt's catch discriminates ENOENT (no profile → fallback) from
// parse/schema errors (deploy defect → fail loud). Pin that discriminant.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("missing profile throws an ENOENT-coded error (→ caller falls back)", () => {
  const root = mkdtempSync(join(tmpdir(), "prof-"));
  try {
    mkdirSync(join(root, "profiles"));
    let code: string | undefined;
    try {
      loadProfile("nope", root);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("ENOENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed profile throws a NON-ENOENT error (→ caller fails loud)", () => {
  const root = mkdtempSync(join(tmpdir(), "prof-"));
  try {
    mkdirSync(join(root, "profiles"));
    writeFileSync(join(root, "profiles", "bad.json"), "{ not valid json");
    let code: string | undefined = "UNSET";
    try {
      loadProfile("bad", root);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code;
    }
    expect(code).not.toBe("ENOENT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

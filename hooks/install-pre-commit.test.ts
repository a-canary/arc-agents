// E2E: install-pre-commit.sh from inside a git WORKTREE.
// Covers the two defects from the "worktree guard fixes are untestable" ticket:
//   1. the installed shim must prefer the current worktree's guard over main's,
//      so a commit that fixes a guard is checked by the fixed guard;
//   2. the installer must derive the hooks dir from --git-common-dir, since in a
//      worktree .git is a FILE and `$toplevel/.git/hooks` cannot be created.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL_SRC = join(REPO, "hooks", "install-pre-commit.sh");

let root: string; // temp root holding main checkout + worktree
let main: string; // main worktree
let wt: string; // linked worktree

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

/** A stand-in guard that just records that it ran, from where. */
function writeGuard(tree: string, name: string, marker: string) {
  const p = join(tree, "hooks", name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `#!/usr/bin/env bash\necho "${marker}"\nexit 0\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "install-pre-commit-"));
  main = join(root, "main");
  wt = join(root, "wt");
  mkdirSync(main, { recursive: true });

  sh("git", ["init", "-b", "main", "."], main);
  sh("git", ["config", "user.email", "t@t.t"], main);
  sh("git", ["config", "user.name", "t"], main);

  writeGuard(main, "pre-commit-slice-guard.sh", "GUARD-FROM-MAIN");
  writeGuard(main, "pre-commit-secret-guard.sh", "SECRET-FROM-MAIN");
  copyFileSync(INSTALL_SRC, join(main, "hooks", "install-pre-commit.sh"));
  sh("git", ["add", "-A"], main);
  sh("git", ["commit", "-m", "seed"], main);

  sh("git", ["worktree", "add", "-b", "feature", wt], main);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("installer runs from inside a worktree (.git is a file)", () => {
  expect(existsSync(join(wt, ".git"))).toBe(true);

  const r = sh("bash", [join(wt, "hooks", "install-pre-commit.sh")], wt);

  expect(r.status).toBe(0);
  // Hook lands in the SHARED common git dir, not in the worktree's .git.
  expect(existsSync(join(main, ".git", "hooks", "pre-commit"))).toBe(true);
});

test("shim prefers the worktree's own guard over main's stale copy", () => {
  sh("bash", [join(wt, "hooks", "install-pre-commit.sh")], wt);

  // The worktree fixes the guard; main still carries the old one.
  writeGuard(wt, "pre-commit-slice-guard.sh", "GUARD-FROM-WORKTREE");
  writeFileSync(join(wt, "f.txt"), "x");
  sh("git", ["add", "-A"], wt);

  const c = sh("git", ["commit", "-m", "fix the guard"], wt);

  expect(c.status).toBe(0);
  const out = c.stdout + c.stderr;
  expect(out).toContain("GUARD-FROM-WORKTREE");
  expect(out).not.toContain("GUARD-FROM-MAIN");
  // The unmodified guard still resolves via the main-worktree fallback.
  expect(out).toContain("SECRET-FROM-MAIN");
});

test("shim falls back to main when the worktree lacks the guard", () => {
  sh("bash", [join(wt, "hooks", "install-pre-commit.sh")], wt);

  rmSync(join(wt, "hooks", "pre-commit-slice-guard.sh"));
  writeFileSync(join(wt, "f.txt"), "x");
  sh("git", ["add", "-A"], wt);

  const c = sh("git", ["commit", "-m", "no guard in tree"], wt);

  expect(c.status).toBe(0);
  expect(c.stdout + c.stderr).toContain("GUARD-FROM-MAIN");
});

test("shim skips (does not hard-fail) when no guard exists anywhere", () => {
  sh("bash", [join(wt, "hooks", "install-pre-commit.sh")], wt);

  for (const tree of [wt, main]) {
    rmSync(join(tree, "hooks", "pre-commit-slice-guard.sh"), { force: true });
    rmSync(join(tree, "hooks", "pre-commit-secret-guard.sh"), { force: true });
  }
  writeFileSync(join(wt, "f.txt"), "x");
  sh("git", ["add", "-A"], wt);

  expect(sh("git", ["commit", "-m", "guardless"], wt).status).toBe(0);
});

test("install is idempotent from a worktree", () => {
  sh("bash", [join(wt, "hooks", "install-pre-commit.sh")], wt);
  const again = sh("bash", [join(wt, "hooks", "install-pre-commit.sh")], wt);

  expect(again.status).toBe(0);
  expect(again.stdout).toContain("no-op");
});

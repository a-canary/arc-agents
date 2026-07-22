// E2E: G-0005 pre-commit slice guard.
// Spins up a temp git repo, mirrors the in-tree guard + installer, exercises
// pass / fail / bypass / install-idempotency cases. Drives the actual
// `git commit` path so the .git/hooks/pre-commit shim fires for real.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_SRC = join(REPO, "hooks", "pre-commit-slice-guard.sh");
const SECRET_SRC = join(REPO, "hooks", "pre-commit-secret-guard.sh");
const INSTALL_SRC = join(REPO, "hooks", "install-pre-commit.sh");

let workDir: string;

function sh(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: workDir,
    env: { ...process.env, ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

function git(args: string[]) {
  return sh("git", args);
}

function runInstall() {
  return sh("bash", [INSTALL_SRC]);
}

function stageFiles(files: Array<[string, string]>): void {
  for (const [p, c] of files) {
    const full = join(workDir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
    git(["add", p]);
  }
}

function commitViaShim(env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  return sh("bash", ["-c", "git commit -m wip"], env);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-slice-guard-test-"));
  // Mirror the in-tree source files into the test workdir so the install
  // (which resolves them via `git rev-parse --show-toplevel`) finds them.
  mkdirSync(join(workDir, "hooks"), { recursive: true });
  copyFileSync(HOOK_SRC, join(workDir, "hooks", "pre-commit-slice-guard.sh"));
  copyFileSync(SECRET_SRC, join(workDir, "hooks", "pre-commit-secret-guard.sh"));
  copyFileSync(INSTALL_SRC, join(workDir, "hooks", "install-pre-commit.sh"));
  sh("chmod", ["+x", join(workDir, "hooks", "pre-commit-slice-guard.sh")]);
  sh("chmod", ["+x", join(workDir, "hooks", "pre-commit-secret-guard.sh")]);
  sh("chmod", ["+x", join(workDir, "hooks", "install-pre-commit.sh")]);

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ─── install behavior ──────────────────────────────────────────────────────

test("install: writes an executable pre-commit shim that execs the guard", () => {
  const r = runInstall();
  expect(r.status).toBe(0);
  const target = join(workDir, ".git", "hooks", "pre-commit");
  expect(existsSync(target)).toBe(true);
  const isExec = sh("test", ["-x", target]);
  expect(isExec.status).toBe(0);
  const cat = sh("cat", [target]);
  expect(cat.stdout).toContain("pre-commit-slice-guard.sh");
});

test("install: idempotent — second run is a no-op", () => {
  const r1 = runInstall();
  expect(r1.status).toBe(0);
  const r2 = runInstall();
  expect(r2.status).toBe(0);
  expect(r2.stdout).toMatch(/already/);
  // No backup file produced
  const ls = sh("ls", [join(workDir, ".git", "hooks")]);
  expect(ls.stdout).not.toMatch(/installed-by-slice-guard/);
});

test("install: backs up and replaces a pre-existing different hook", () => {
  const target = join(workDir, ".git", "hooks", "pre-commit");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "#!/bin/bash\necho 'old unrelated hook'\n");
  sh("chmod", ["+x", target]);

  const r = runInstall();
  expect(r.status).toBe(0);
  expect(r.stderr).toMatch(/backed up/);

  // Backup file present
  const ls = sh("ls", [join(workDir, ".git", "hooks")]);
  expect(ls.stdout).toMatch(/pre-commit\.installed-by-slice-guard/);

  // Replaced file points at the slice guard
  const cat = sh("cat", [target]);
  expect(cat.stdout).toContain("pre-commit-slice-guard.sh");
});

test("install: refuses if the in-tree source script is missing", () => {
  rmSync(join(workDir, "hooks", "pre-commit-slice-guard.sh"));
  const r = runInstall();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/not found/);
});

// ─── hook behavior (driven through the real .git/hooks/pre-commit path) ───

test("hook: passes on a single-area small commit", () => {
  runInstall();
  stageFiles([["bin/x.ts", "console.log('x');\n"]]);
  const r = commitViaShim();
  expect(r.status).toBe(0);
});

test("hook: fails on a multi-area commit (bin + src)", () => {
  runInstall();
  stageFiles([
    ["bin/x.ts", "console.log('x');\n"],
    ["src/y.ts", "console.log('y');\n"],
  ]);
  const r = commitViaShim();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/slice-guard/);
  expect(r.stderr).toMatch(/areas/);
});

test("hook: fails on a single-area commit exceeding the 2000-line cap", () => {
  runInstall();
  // 2100 added lines in one file, all in `bin/`
  const big = Array(2100).fill("x").join("\n") + "\n";
  stageFiles([["bin/big.ts", big]]);
  const r = commitViaShim();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/modified-line.*cap/);
});

test("hook: SLICE_GUARD_SKIP=1 bypasses the area check", () => {
  runInstall();
  stageFiles([
    ["bin/x.ts", "x\n"],
    ["src/y.ts", "y\n"],
  ]);
  const r = commitViaShim({ SLICE_GUARD_SKIP: "1" });
  expect(r.status).toBe(0);
});

test("hook: exits 0 when invoked directly with no staged changes", () => {
  runInstall();
  // Bypass git's "nothing to commit" — the hook itself is what we want to test.
  // Empty staged diff → hook's `if [[ -z "$diff_output" ]]; then exit 0; fi`.
  const r = sh("bash", [join(workDir, ".git", "hooks", "pre-commit")]);
  expect(r.status).toBe(0);
  expect(r.stdout).toBe("");
});

test("hook: counts a top-level file (no slash) as area '_root' alongside another area", () => {
  runInstall();
  stageFiles([
    ["README.md", "# hi\n"],
    ["bin/x.ts", "x\n"],
  ]);
  const r = commitViaShim();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/slice-guard/);
});

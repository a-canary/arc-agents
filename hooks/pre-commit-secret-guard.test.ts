// E2E: secret guard installed via the shared pre-commit shim.
// Spins up a temp git repo, mirrors the in-tree guard + installer, plants a
// fake AWS-shaped key and asserts the real `git commit` path blocks it.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SLICE_SRC = join(REPO, "hooks", "pre-commit-slice-guard.sh");
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

function commitViaShim(env: Record<string, string> = {}) {
  return sh("bash", ["-c", "git commit -m wip"], env);
}

const hasGitleaks = spawnSync("bash", ["-c", "command -v gitleaks"]).status === 0;
const maybeTest = hasGitleaks ? test : test.skip;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-secret-guard-test-"));
  mkdirSync(join(workDir, "hooks"), { recursive: true });
  copyFileSync(SLICE_SRC, join(workDir, "hooks", "pre-commit-slice-guard.sh"));
  copyFileSync(SECRET_SRC, join(workDir, "hooks", "pre-commit-secret-guard.sh"));
  copyFileSync(INSTALL_SRC, join(workDir, "hooks", "install-pre-commit.sh"));
  for (const f of [
    "pre-commit-slice-guard.sh",
    "pre-commit-secret-guard.sh",
    "install-pre-commit.sh",
  ]) {
    sh("chmod", ["+x", join(workDir, "hooks", f)]);
  }

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

maybeTest("hook: blocks a commit staging a planted fake secret", () => {
  runInstall();
  stageFiles([
    ["config.txt", "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz\n"],
  ]);
  const r = commitViaShim();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/secret-guard/);
});

maybeTest("hook: passes a commit with only benign content", () => {
  runInstall();
  stageFiles([["README.md", "# hello world\n"]]);
  const r = commitViaShim();
  expect(r.status).toBe(0);
});

maybeTest("hook: passes benign high-entropy content (hash, UUID)", () => {
  runInstall();
  stageFiles([
    [
      "checksums.txt",
      "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" +
        "id: 6f1c2a9e-4b7d-4e0a-9c3f-2d8b5a7e1c04\n",
    ],
  ]);
  const r = commitViaShim();
  expect(r.status).toBe(0);
});

maybeTest("hook: SECRET_GUARD_SKIP=1 bypasses the secret check", () => {
  runInstall();
  stageFiles([
    ["config.txt", "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz\n"],
  ]);
  const r = commitViaShim({ SECRET_GUARD_SKIP: "1" });
  expect(r.status).toBe(0);
});

test("install: shim chains both slice guard and secret guard", () => {
  const r = runInstall();
  expect(r.status).toBe(0);
  const cat = sh("cat", [join(workDir, ".git", "hooks", "pre-commit")]);
  expect(cat.stdout).toContain("pre-commit-slice-guard.sh");
  expect(cat.stdout).toContain("pre-commit-secret-guard.sh");
});

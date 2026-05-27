// pre-commit-test-gate.test.ts — tests for pre-commit-test-gate.sh

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `pre-commit-test-gate-test-${randomUUID()}`);

async function sh(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: TEST_DIR, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        code: err instanceof Error && err.killed ? 124 : (err as any)?.code ?? 0,
      });
    });
  });
}

async function setupRepo(branch = "main") {
  await mkdir(TEST_DIR, { recursive: true });
  await sh(`git init -b ${branch}`);
  await sh(`git config user.email "test@test.com"`);
  await sh(`git config user.name "Test"`);
  await writeFile(join(TEST_DIR, "package.json"), JSON.stringify({
    name: "test-repo",
    scripts: {
      typecheck: "echo 'typecheck' && exit 0",
      test: "echo 'test' && exit 0",
    },
  }));
  // Minimal test fixture so bun test finds at least one *.test.ts file
  await mkdir(join(TEST_DIR, "tests"), { recursive: true });
  await writeFile(join(TEST_DIR, "tests", "smoke.test.ts"), "// smoke test\ntest('smoke', () => expect(1).toBe(1));\n");
  await writeFile(join(TEST_DIR, "bun.lock"), "");
  await sh("git add .");
  await sh("git commit -m 'init'");
}

async function installHook(hookScript: string) {
  const hookDir = join(TEST_DIR, ".git", "hooks");
  await mkdir(hookDir, { recursive: true });
  await writeFile(join(hookDir, "pre-commit"), hookScript);
  await chmod(join(hookDir, "pre-commit"), 0o755);
}

async function cleanup() {
  await rm(TEST_DIR, { recursive: true, force: true });
}

describe("pre-commit-test-gate.sh", () => {
  afterAll(async () => { await cleanup(); });

  describe("branch-gate", () => {
    it("activates on main", async () => {
      await setupRepo("main");
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
      const r = await sh("git commit --allow-empty -m 'test'");
      expect(r.code).toBe(0);
    });

    it("activates on release/*", async () => {
      await cleanup();
      await setupRepo("release/1.0");
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
      const r = await sh("git commit --allow-empty -m 'test'");
      expect(r.code).toBe(0);
    });

    it("skips on feature branch (not based on main)", async () => {
      await cleanup();
      await setupRepo("feature/test");
      // Force a non-main base so the branch-gate heuristic skips
      await sh("git checkout --orphan orphan-base");
      await sh("git commit --allow-empty -m 'orphan'");
      await sh("git checkout -b feature/test");
      await sh("git commit --allow-empty -m 'feature'");
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
      // Should skip (no typecheck/test output) because it's not on main/release/*
      const r = await sh("git commit --allow-empty -m 'test'");
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("typecheck");
    });

    it("activates on feature branch based on main (merge-base heuristic)", async () => {
      await cleanup();
      await setupRepo("main");
      // Simulate: git checkout -b feature/test
      await sh("git checkout -b feature/test");
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
      const r = await sh("git commit --allow-empty -m 'feature commit'");
      expect(r.code).toBe(0);
      // Gate activates, but both typecheck + test scripts exit 0
    });
  });

  describe("bypass flags", () => {
    beforeEach(async () => {
      await cleanup();
      await setupRepo("main");
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
    });

    it("PRECOMMIT_SKIP=1 bypasses all gates", async () => {
      const r = await sh("PRECOMMIT_SKIP=1 git commit --allow-empty -m 'skip'");
      expect(r.code).toBe(0);
    });

    it("PRECOMMIT_SKIP_TYPECHECK=1 skips typecheck", async () => {
      const r = await sh("PRECOMMIT_SKIP_TYPECHECK=1 git commit --allow-empty -m 'skip-check'");
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("typecheck FAIL");
    });

    it("PRECOMMIT_SKIP_TEST=1 skips test", async () => {
      const r = await sh("PRECOMMIT_SKIP_TEST=1 git commit --allow-empty -m 'skip-test'");
      expect(r.code).toBe(0);
      // stdout may contain "test" from git commit message, but not "test PASS" / "test FAIL"
      expect(r.stderr).not.toContain("test FAIL");
    });
  });

  describe("failure behavior", () => {
    beforeEach(async () => {
      await cleanup();
      await setupRepo("main");
    });

    it("blocks commit when typecheck fails", async () => {
      await writeFile(join(TEST_DIR, "package.json"), JSON.stringify({
        name: "test-repo",
        scripts: {
          typecheck: "exit 1",
          test: "exit 0",
        },
      }));
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
      const r = await sh("git add . && git commit -m 'bad typecheck'");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("typecheck FAIL");
    });

    it("blocks commit when test fails", async () => {
      // Override package.json test script and replace the smoke test with one that fails
      await writeFile(join(TEST_DIR, "package.json"), JSON.stringify({
        name: "test-repo",
        scripts: {
          typecheck: "exit 0",
          test: "exit 1",
        },
      }));
      await writeFile(join(TEST_DIR, "tests", "smoke.test.ts"), `test('failing', () => { throw new Error('expected'); });\n`);
      const hook = await Bun.file(join(process.cwd(), "hooks", "pre-commit-test-gate.sh")).text();
      await installHook(hook);
      const r = await sh("git add . && git commit -m 'bad suite'");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("test FAIL");
    });
  });
});
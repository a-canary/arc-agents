import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";

const GUARD = join(import.meta.dir, "slice-guard.sh");

function sh(cmd: string, cwd: string) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function runGuard(cwd: string, env: Record<string, string> = {}) {
  const res = spawnSync("bash", [GUARD], {
    cwd,
    env: { ...process.env, PROJECT: cwd, ...env },
    encoding: "utf8",
  });
  return { code: res.status ?? 0, stdout: res.stdout, stderr: res.stderr };
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "slice-guard-"));
  sh("git init -q", dir);
  sh("git config user.email t@t", dir);
  sh("git config user.name t", dir);
  sh("git config commit.gpgsign false", dir);
  // baseline commit on main
  writeFileSync(join(dir, "README.md"), "base\n");
  sh("git add README.md", dir);
  sh("git commit -q -m base", dir);
  sh("git branch -M main", dir);
  // simulate origin/main pointing at base
  sh("git update-ref refs/remotes/origin/main HEAD", dir);
  sh("git checkout -q -b feature", dir);
  return dir;
}

describe("slice-guard", () => {
  let dir: string;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("PASS when no changes vs base", () => {
    const r = runGuard(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"status":"PASS"');
  });

  test("PASS for small single-area change", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
    sh("git add src/a.ts", dir);
    sh("git commit -q -m feat", dir);
    const r = runGuard(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"status":"PASS"');
    expect(r.stdout).toContain("areas=1/1");
  });

  test("FAIL when modified-line cap exceeded", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    const big = Array.from({ length: 2100 }, (_, i) => `line${i}`).join("\n") + "\n";
    writeFileSync(join(dir, "src/big.ts"), big);
    sh("git add src/big.ts", dir);
    sh("git commit -q -m big", dir);
    const r = runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('"status":"FAIL"');
    expect(r.stderr).toContain("modified-line cap exceeded");
  });

  test("FAIL when area cap exceeded", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "x\n");
    writeFileSync(join(dir, "bin/b.sh"), "y\n");
    sh("git add -A", dir);
    sh("git commit -q -m two-areas", dir);
    const r = runGuard(dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('"status":"FAIL"');
    expect(r.stderr).toContain("top-level area cap exceeded");
  });

  test("PASS multi-area when MAX_AREAS raised", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "x\n");
    writeFileSync(join(dir, "bin/b.sh"), "y\n");
    sh("git add -A", dir);
    sh("git commit -q -m two-areas", dir);
    const r = runGuard(dir, { MAX_AREAS: "2" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"status":"PASS"');
  });

  test("SKIP when SLICE_GUARD_SKIP=1", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    const big = Array.from({ length: 5000 }, () => "x").join("\n");
    writeFileSync(join(dir, "src/big.ts"), big);
    sh("git add -A", dir);
    sh("git commit -q -m big", dir);
    const r = runGuard(dir, { SLICE_GUARD_SKIP: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"status":"SKIP"');
  });

  test("excludes lock files from line count", () => {
    writeFileSync(join(dir, "bun.lockb"), Array.from({ length: 5000 }, () => "x").join("\n"));
    sh("git add -A", dir);
    sh("git commit -q -m lock", dir);
    const r = runGuard(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"status":"PASS"');
  });

  test("SKIP when no base ref resolvable", () => {
    // remove origin/main and main
    sh("git update-ref -d refs/remotes/origin/main", dir);
    sh("git branch -D main 2>/dev/null || true", dir);
    const r = runGuard(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"status":"SKIP"');
  });
});

// E2E: SessionStart hook prints role + ready-task count from the ledger.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, "hooks", "session-start.sh");
const LEDGER = join(REPO, "bin", "ledger.ts");

let workDir: string;
let dbPath: string;

function ledger(args: string[]): { stdout: string; status: number } {
  const r = spawnSync("bun", [LEDGER, ...args, "--db", dbPath], { encoding: "utf8" });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

function runHook(env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  // Hook hardcodes $HOME/vault/ledger.db — override HOME to our temp dir.
  const fakeHome = join(workDir, "home");
  const vault = join(fakeHome, "vault");
  spawnSync("mkdir", ["-p", vault]);
  // Copy db + WAL sidecars so uncheckpointed writes are visible.
  for (const suf of ["", "-wal", "-shm"]) {
    spawnSync("cp", [dbPath + suf, join(vault, "ledger.db" + suf)]);
  }
  const clean = { ...process.env, HOME: fakeHome, ...env };
  delete clean.ARC_LEDGER_DB;
  const r = spawnSync("bash", [HOOK], { encoding: "utf8", env: clean });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-sstart-test-"));
  dbPath = join(workDir, "ledger.db");
  ledger(["init"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("prints role + worktree banner", () => {
  const r = runHook({ ARC_ROLE: "worker" });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/role=worker/);
});

test("counts only ready tasks (kind='task'), not other kinds", () => {
  ledger(["create", "--kind", "task", "--type", "mvp", "--title", "real task"]);
  ledger(["create", "--kind", "prd", "--type", "mvp", "--title", "a prd"]);
  ledger(["create", "--kind", "event", "--type", "mvp", "--source-module", "arc-chat", "--title", "chat"]);
  const r = runHook({ ARC_ROLE: "worker" });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/ready tasks.*: 1/);
});

test("zero ready tasks shows 0, not '?'", () => {
  const r = runHook({ ARC_ROLE: "worker" });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/ready tasks.*: 0/);
});

test("prints profile context_files + boot_skills when role profile exists", () => {
  const r = runHook({ ARC_ROLE: "developer" });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/profile:.*developer\.json/);
  expect(r.stdout).toMatch(/context_files/);
  expect(r.stdout).toMatch(/roles\/AGENTS\.md/);
  expect(r.stdout).toMatch(/boot_skills.*\/ke-recall/);
});

test("unknown role skips profile block", () => {
  const r = runHook({ ARC_ROLE: "unknown" });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toMatch(/profile:/);
});

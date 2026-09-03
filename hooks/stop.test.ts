// E2E: Stop hook behavior against a real ledger.
// We exec the hook directly with controlled env + stdin and inspect decision JSON.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, "hooks", "stop.sh");
const LEDGER = join(REPO, "bin", "ledger.ts");

let workDir: string;
let dbPath: string;

function ledger(args: string[]): { stdout: string; status: number } {
  const r = spawnSync("bun", [LEDGER, ...args, "--db", dbPath], {
    encoding: "utf8",
    env: { ...process.env, ARC_SKIP_MERGE_TRUTH: "1" },
  });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

function runHook(env: Record<string, string>, stdin = "{}"): { stdout: string; status: number } {
  const { ARC_TASK_ID: _drop, ...parent } = process.env;
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf8",
    input: stdin,
    env: { ...parent, ARC_LEDGER_DB: dbPath, ...env },
  });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-stop-test-"));
  dbPath = join(workDir, "ledger.db");
  ledger(["init"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("passes through when ARC_TASK_ID is unset (non-worker session)", () => {
  const r = runHook({});
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("");
});

test("blocks with checklist when task is in non-terminal state", () => {
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  ledger(["update", c.id, "--state", "claimed"]);
  const r = runHook({ ARC_TASK_ID: c.id });
  expect(r.status).toBe(0);
  const payload = JSON.parse(r.stdout);
  expect(payload.decision).toBe("block");
  expect(payload.reason).toMatch(/AFK shutdown checklist/);
  expect(payload.reason).toMatch(/claimed/);
});

test("block reason mentions the hygiene phase + hygiene-emit command + 4 hygiene skills", () => {
  // Slice D acceptance: the AFK shutdown checklist now suggests the worker
  // emit hygiene followups through bookie, naming all four skills.
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  ledger(["update", c.id, "--state", "claimed"]);
  const r = runHook({ ARC_TASK_ID: c.id });
  expect(r.status).toBe(0);
  const payload = JSON.parse(r.stdout);
  expect(payload.reason).toMatch(/HYGIENE PHASE/);
  expect(payload.reason).toMatch(/hygiene-emit/);
  expect(payload.reason).toMatch(/clarify-docs/);
  expect(payload.reason).toMatch(/improve-architecture/);
  expect(payload.reason).toMatch(/trash-retired-files/);
  expect(payload.reason).toMatch(/analyse-recent-sessions/);
});

test("passes through when task is merged", () => {
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  ledger([
    "event",
    c.id,
    "in_place_review",
    JSON.stringify({
      reviewer_identity: "hook-test-reviewer",
      justification: "hygiene-only test row, no code change",
    }),
  ]);
  ledger(["update", c.id, "--state", "merged", "--evidence", "ok", "--in-place"]);
  const r = runHook({ ARC_TASK_ID: c.id });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("");
});

test("passes through when task is blocked (decomposed)", () => {
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  ledger(["decompose", c.id, "--child", "step a"]);
  const r = runHook({ ARC_TASK_ID: c.id });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("");
});

test("passes through when stop_hook_active is true (avoids infinite loop)", () => {
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  ledger(["update", c.id, "--state", "claimed"]);
  const r = runHook({ ARC_TASK_ID: c.id }, '{"stop_hook_active": true}');
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("");
});

// E2E: SessionEnd hook emits a ledger event when ARC_TASK_ID is set.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO, "hooks", "session-end.sh");
const LEDGER = join(REPO, "bin", "ledger.ts");

let workDir: string;
let dbPath: string;
let fakeHome: string;

function ledger(args: string[]): { stdout: string; status: number } {
  const r = spawnSync("bun", [LEDGER, ...args, "--db", dbPath], { encoding: "utf8" });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

function runHook(env: Record<string, string>): { stdout: string; status: number } {
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf8",
    env: { ...process.env, HOME: fakeHome, ...env },
  });
  return { stdout: r.stdout, status: r.status ?? 1 };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-session-end-test-"));
  fakeHome = join(workDir, "home");
  const vaultDir = join(fakeHome, "vault");
  spawnSync("mkdir", ["-p", vaultDir]);
  dbPath = join(vaultDir, "ledger.db");
  ledger(["init"]);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("emits session-end event when ARC_TASK_ID is set", () => {
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  const r = runHook({ ARC_TASK_ID: c.id, ARC_ROLE: "developer" });
  expect(r.status).toBe(0);

  const show = JSON.parse(ledger(["show", c.id]).stdout);
  const evt = show.events.find((e: any) => e.kind === "note" && e.payload_md?.startsWith("session-end"));
  expect(evt).toBeTruthy();
  expect(evt.payload_md).toContain("developer");
  expect(evt.payload_md).toContain(c.id);
});

test("no-ops when ARC_TASK_ID is unset", () => {
  const c = JSON.parse(ledger(["create", "--kind", "task", "--type", "mvp", "--title", "t"]).stdout);
  const r = runHook({});
  expect(r.status).toBe(0);

  const show = JSON.parse(ledger(["show", c.id]).stdout);
  const evt = show.events.find((e: any) => e.kind === "note" && e.payload_md?.startsWith("session-end"));
  expect(evt).toBeFalsy();
});

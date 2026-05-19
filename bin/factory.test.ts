// E2E: factory spawns ephemeral workers that claim from the ledger and exit.
// Fake CLAUDE_BIN=/bin/true so no real claude is invoked — we verify the
// spawn lifecycle, claim atomicity, and reap behavior, not model output.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FACTORY = join(REPO, "bin", "factory.ts");
const LEDGER = join(REPO, "bin", "ledger.ts");

let workDir: string;
let dbPath: string;
let fakeClaude: string;
let prefix: string;

function bun(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", args, {
    encoding: "utf8",
    env: { ...process.env, ARC_LEDGER_DB: dbPath, CLAUDE_BIN: fakeClaude, ARC_WORKER_PREFIX: prefix, ...env },
  });
}

function tmux(args: string[]) {
  return spawnSync("tmux", args, { encoding: "utf8" });
}

function listWorkers(): string[] {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((s) => s.startsWith(`${prefix}-`));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-factory-test-"));
  dbPath = join(workDir, "ledger.db");
  // Fake claude: a script that claims via ledger and exits 0 immediately.
  // (We can't easily exercise the full agent flow in a unit test; we test
  // factory's responsibility — spawning workers up to N when work exists.)
  fakeClaude = join(workDir, "fake-claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);
  prefix = `arctest-${Math.random().toString(36).slice(2, 8)}`;

  // Init ledger
  const r = bun([LEDGER, "init"]);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
});

afterEach(() => {
  // Kill any test tmux sessions
  for (const s of listWorkers()) tmux(["kill-session", "-t", s]);
  rmSync(workDir, { recursive: true, force: true });
});

function createTask(title: string, _type = "mvp") {
  const r = bun([LEDGER, "create", "--kind", "task", "--class", "MVP", "--urgency", "nominal", "--title", title]);
  if (r.status !== 0) throw new Error(`create failed: ${r.stderr}`);
  return JSON.parse(r.stdout).id;
}

test("factory --once spawns no workers when ledger is empty", () => {
  const r = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "4" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.ready).toBe(0);
  expect(result.spawned).toEqual([]);
});

test("factory --once spawns one worker per ready task up to N_MAX", () => {
  createTask("t1");
  createTask("t2");
  createTask("t3");
  const r = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "2" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.ready).toBe(3);
  expect(result.spawned.length).toBe(2); // capped at N_MAX, not ready count
});

test("factory --once sweeps stale claims back to ready before counting work", async () => {
  const id = createTask("hung");
  const threeHrsAgo = Math.floor(Date.now() / 1000) - 3 * 3600;
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  db.run("UPDATE issues SET state='claimed', claimed_by='ghost', claimed_at=? WHERE id=?", [threeHrsAgo, id]);
  db.close();

  const r = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "4" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.swept).toEqual([id]);
  expect(result.ready).toBe(1);
  expect(result.spawned.length).toBe(1);
});

test("factory --reap kills sessions older than MAX_AGE", () => {
  // Spawn a session manually that will look stale (MAX_AGE=0 makes everything stale)
  const sessName = `${prefix}-stale1`;
  tmux(["new-session", "-d", "-s", sessName, "sleep", "300"]);
  expect(listWorkers()).toContain(sessName);

  const r = bun([FACTORY, "--reap"], { ARC_WORKER_MAX_AGE: "0" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.reaped).toContain(sessName);
  expect(listWorkers()).not.toContain(sessName);
});

test("factory --once reaps sessions whose child process exited (pane_dead)", async () => {
  // Create a session that runs `true` — exits ~immediately, leaving a dead pane
  // if remain-on-exit is on. Force remain-on-exit to keep the session alive
  // after the child exits, simulating the lingering-session bug.
  const sessName = `${prefix}-dead1`;
  // Start with a long-lived child so the session exists, set remain-on-exit,
  // then respawn the pane with a command that exits immediately — leaves the
  // pane in dead state instead of destroying the session.
  tmux(["new-session", "-d", "-s", sessName, "sleep", "300"]);
  tmux(["set-option", "-t", sessName, "remain-on-exit", "on"]);
  tmux(["respawn-pane", "-t", sessName, "-k", "true"]);
  await new Promise((r) => setTimeout(r, 300));

  const r = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "4", ARC_WORKER_MAX_AGE: "3600" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.reaped).toContain(sessName);
  expect(listWorkers()).not.toContain(sessName);
});

test("factory does not reap sessions younger than MAX_AGE", () => {
  const sessName = `${prefix}-fresh1`;
  tmux(["new-session", "-d", "-s", sessName, "sleep", "300"]);
  const r = bun([FACTORY, "--reap"], { ARC_WORKER_MAX_AGE: "3600" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.reaped).not.toContain(sessName);
  expect(listWorkers()).toContain(sessName);
});

test("worker-shell.sh claims atomically: only one of two parallel shells wins for one task", () => {
  const id = createTask("solo");
  const shell = join(REPO, "bin", "worker-shell.sh");
  const env = { ...process.env, ARC_LEDGER_DB: dbPath, CLAUDE_BIN: fakeClaude };
  // Run two shells in parallel; both attempt claim, exactly one should succeed.
  const r1 = spawnSync("bash", [shell, "w1"], { encoding: "utf8", env });
  const r2 = spawnSync("bash", [shell, "w2"], { encoding: "utf8", env });
  // Each exits 0; one will exec fake-claude (which exits 0), the other prints claimed=null and exits 0.
  const outs = [r1.stdout, r2.stdout].join("");
  // Exactly one race-lost message expected (the other shell exec'd claude with no stdout).
  const lost = (outs.match(/race-lost-or-empty/g) ?? []).length;
  expect(lost).toBe(1);
  // Verify the task is claimed in the ledger.
  const show = bun([LEDGER, "show", id]);
  const issue = JSON.parse(show.stdout).issue;
  expect(issue.state).toBe("claimed");
  expect(["w1", "w2"]).toContain(issue.claimed_by);
});

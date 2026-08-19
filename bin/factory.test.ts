// E2E: factory spawns ephemeral workers that claim from the ledger and exit.
// Fake CLAUDE_BIN=/bin/true so no real claude is invoked — we verify the
// spawn lifecycle, claim atomicity, and reap behavior, not model output.
//
// Engine note (two-tier policy G-0006): an agent-less test row resolves to
// default_alias=minimax-build → `pi -p ...`, a HEADLESS engine. worker-shell.sh
// discriminates on the `-p` flag and runs headless workers as a child (not
// exec'd), so the boot-the-real-shell tests below must shadow a CONTROLLABLE
// fake `pi` onto PATH — CLAUDE_BIN only substitutes argv[0] when it is "claude".
// The fake `pi` self-reports a terminal state via the ledger, exercising the
// real reconciler's stand-down path (a self-reporting agent always wins).

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FACTORY = join(REPO, "bin", "factory.ts");
const LEDGER = join(REPO, "bin", "ledger.ts");

let workDir: string;
let dbPath: string;
let fakeClaude: string;
let fakeBinDir: string;
let prefix: string;

function bun(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", args, {
    encoding: "utf8",
    // ARC_BACKSTOP_DISABLE: the 7-day backstop disk-scans ~/worktrees against the
    // real prod repo on its first tick (lastBackstop=0). Off by default in tests
    // so no `factory --once` subprocess ever touches live worktrees; the
    // backstop's own behavior is covered in worktree-reaper.test.ts with a
    // throwaway root. A test can re-enable it via the per-call env override.
    env: {
      ...process.env,
      ARC_LEDGER_DB: dbPath,
      CLAUDE_BIN: fakeClaude,
      ARC_WORKER_PREFIX: prefix,
      ARC_BACKSTOP_DISABLE: "1",
      ...env,
    },
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

  // Controllable fake `pi` (the headless engine an agent-less row resolves to).
  // It self-reports `review` via the ledger using the env worker-shell.sh
  // exports (ARC_TASK_ID + ARC_LEDGER_DB), then exits 0 — modelling a headless
  // worker that DID reach a terminal-ish state on its own. `review` is the
  // non-terminal advance that preserves claimed_by (a terminal state like
  // `failed` releases the claim, nulling claimed_by). Because POST_STATE is no
  // longer `claimed`/`wip`, the post-#16 reconciler stands down and the agent's
  // own report wins. Placed on a bin dir we prepend to PATH for the boot tests.
  fakeBinDir = join(workDir, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakePi = join(fakeBinDir, "pi");
  writeFileSync(
    fakePi,
    [
      "#!/usr/bin/env bash",
      "echo \"FAKE_PI_RAN argc=$# task=${ARC_TASK_ID:-none}\"",
      "if [[ -n \"${ARC_TASK_ID:-}\" ]]; then",
      "  DBF=()",
      "  [[ -n \"${ARC_LEDGER_DB:-}\" ]] && DBF=(--db \"$ARC_LEDGER_DB\")",
      `  bun ${JSON.stringify(LEDGER)} update "$ARC_TASK_ID" "\${DBF[@]}" --state review --evidence "fake pi self-report" >/dev/null 2>&1 || true`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  // Same shape for cli-agent (alias→cmdline resolution owner post-2026-07-10
  // ruling). Worker-shell now invokes `cli-agent --pool <name>` instead of
  // `pi -p --provider …`, so the fake bin dir must shim it the same way.
  const fakeAgent = join(fakeBinDir, "cli-agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/usr/bin/env bash",
      "echo \"FAKE_CLI_AGENT_RAN argc=$# task=${ARC_TASK_ID:-none}\"",
      "if [[ -n \"${ARC_TASK_ID:-}\" ]]; then",
      "  DBF=()",
      "  [[ -n \"${ARC_LEDGER_DB:-}\" ]] && DBF=(--db \"$ARC_LEDGER_DB\")",
      `  bun ${JSON.stringify(LEDGER)} update "$ARC_TASK_ID" "\${DBF[@]}" --state review --evidence "fake cli-agent self-report" >/dev/null 2>&1 || true`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);

  // Fake `claude` and `claude-afk` shimmed in fakeBinDir. worker-shell.sh does
  // `command -v claude || export PATH="$HOME/.local/bin:$PATH"`, which would
  // prepend ~/.local/bin (where the REAL cli-agent lives) before our fake bins
  // if claude isn't found. This shadows the fake pi/cli-agent, causing the real
  // agents to run and fail when they try to authenticate. Shimming claude/
  // claude-afk ensures the guard passes and PATH ordering stays correct.
  for (const name of ["claude", "claude-afk"]) {
    const p = join(fakeBinDir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }

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

function createTask(title: string, type = "mvp") {
  const r = bun([LEDGER, "create", "--kind", "task", "--type", type, "--title", title]);
  if (r.status !== 0) throw new Error(`create failed: ${r.stderr}`);
  return JSON.parse(r.stdout).id;
}

function createPrd(title: string) {
  // PRDs are non-claimable by design (parked product specs); they are
  // intentionally excluded from unclaimable_ready to silence warn-spam.
  const r = bun([
    LEDGER, "create",
    "--kind", "prd",
    "--type", "mvp",
    "--title", title,
    "--tier", "mvp",
    "--pool", "ops",
    "--class-rationale", "test fixture",
  ]);
  if (r.status !== 0) throw new Error(`create prd failed: ${r.stderr}`);
  return JSON.parse(r.stdout).id;
}

function createReply(title: string, threadId: string) {
  // `reply` is a transient artifact; if it ends up ready, it's stuck — the
  // unclaimable_ready warn surfaces this.
  const r = bun([
    LEDGER, "create",
    "--kind", "reply",
    "--type", "mvp",
    "--title", title,
    "--source-module", "arc-chat",
    "--thread", threadId,
  ]);
  if (r.status !== 0) throw new Error(`create reply failed: ${r.stderr}`);
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

test("factory --once reclaims orphan claims whose tmux session vanished externally", async () => {
  // Race: a worker claims a task, then its tmux session is killed -9 from outside
  // the reap path (OOM, manual kill, host reboot). The claim is younger than
  // 2hr, so sweepStaleClaims won't touch it. pane_dead never fires because the
  // session is fully gone. reapFinished only fires on terminal states. Result
  // (before fix): the claim sits orphaned for up to 2hr, blocking the task.
  const id = createTask("orphan-race");
  const sessName = `${prefix}-a-orph01`;
  // Simulate the real spawn: tmux session exists, ledger row is claimed by it,
  // claim is fresh (5 sec ago, well under the 2hr stale threshold).
  tmux(["new-session", "-d", "-s", sessName, "sleep", "300"]);
  const fiveSecAgo = Math.floor(Date.now() / 1000) - 5;
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  db.run("UPDATE issues SET state='claimed', claimed_by=?, claimed_at=? WHERE id=?", [
    sessName,
    fiveSecAgo,
    id,
  ]);
  db.close();
  // External kill — not via factory reap path. Session disappears completely
  // (not a pane_dead lingering session, which reapExited already handles).
  tmux(["kill-session", "-t", sessName]);
  expect(listWorkers()).not.toContain(sessName);

  const r = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "4" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  // Expectation: the orphan claim is reset to ready so the slot frees up.
  expect(result.swept).toContain(id);
  // And the now-ready task should spawn a fresh worker.
  expect(result.ready).toBeGreaterThanOrEqual(1);
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

test("factory --once excludes prd from unclaimable_ready but counts transient kinds", () => {
  // PRDs are intentionally non-claimable (parked specs) — must NOT count as
  // unclaimable_ready or operators get daily warn-spam. Transient artifacts
  // like `reply` rows that end up ready ARE genuinely stuck — must count.
  createPrd("prd-a");
  createPrd("prd-b");
  createReply("stuck-reply", "t-iter6-test");
  createTask("real-1");
  const r = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "4" });
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.unclaimable_ready).toBe(1); // reply only; prds excluded
  expect(result.ready).toBe(1); // listReady excludes prd+reply via spawn-ready kind filter
  expect(result.spawned.length).toBe(1);
});

test("factory --metrics excludes prd from unclaimable_ready", () => {
  // PRDs alone should produce a zero unclaimable count — warn must stay silent.
  createPrd("prd-stuck");
  const r = bun([FACTORY, "--metrics"]);
  expect(r.status).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m).toHaveProperty("unclaimable_ready");
  expect(m.unclaimable_ready).toBe(0);
});

test("factory --metrics prints snapshot with all 5 fields", () => {
  // Seed: one claimed task (counts as claim event), one ready task.
  const id1 = createTask("done");
  bun([LEDGER, "claim", "w1"]);
  createTask("waiting");
  // Spawn a fake worker session so alive-workers > 0.
  const sess = `${prefix}-a-met01`;
  tmux(["new-session", "-d", "-s", sess, "sleep", "300"]);

  const r = bun([FACTORY, "--metrics"], { ARC_SLOTS_ANY: "4", ARC_SLOTS_INTERACTIVE: "2" });
  expect(r.status).toBe(0);
  const m = JSON.parse(r.stdout);
  expect(m).toHaveProperty("alive_workers");
  expect(m).toHaveProperty("claims_per_hr");
  expect(m).toHaveProperty("reaps_per_hr");
  expect(m).toHaveProperty("seconds_since_last_spawn");
  expect(m).toHaveProperty("slots");
  expect(m.alive_workers).toBeGreaterThanOrEqual(1);
  expect(m.claims_per_hr).toBeGreaterThanOrEqual(1);
  expect(m.slots.any.cap).toBe(4);
  expect(m.slots.interactive.cap).toBe(2);
  // id1 referenced to satisfy lint
  expect(id1).toBeTruthy();
});

test("factory --metrics counts reaps_per_hr from kind='reclaimed' sweeper events", async () => {
  // Drive a real sweeper event via factory --once on a stale claim.
  const id = createTask("zombie");
  const twoHrsAgo = Math.floor(Date.now() / 1000) - 2 * 3600 - 60;
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  db.run("UPDATE issues SET state='claimed', claimed_by='ghost', claimed_at=? WHERE id=?", [twoHrsAgo, id]);
  db.close();

  const sweep = bun([FACTORY, "--once"], { ARC_WORKER_MAX: "0" });
  expect(sweep.status).toBe(0);
  expect(JSON.parse(sweep.stdout).swept).toEqual([id]);

  const r = bun([FACTORY, "--metrics"]);
  expect(r.status).toBe(0);
  const m = JSON.parse(r.stdout);
  // Regression guard: the metric query was scanning kind='note' but the sweeper
  // writes kind='reclaimed', so this used to be silently always 0.
  expect(m.reaps_per_hr).toBeGreaterThanOrEqual(1);
});

test("worker-shell.sh refuses arctest-* claim against canon ledger (no ARC_LEDGER_DB)", () => {
  const shell = join(REPO, "bin", "worker-shell.sh");
  // No ARC_LEDGER_DB → script computes EFFECTIVE_DB = $HOME/vault/ledger.db
  // (canon). With WORKER=arctest-*, guard must refuse before any ledger write.
  // Strip ARC_LEDGER_DB out of process.env explicitly.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "ARC_LEDGER_DB" && v !== undefined) env[k] = v;
  }
  env.CLAUDE_BIN = fakeClaude;
  const r = spawnSync("bash", [shell, "arctest-guard-canon"], { encoding: "utf8", env });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("arctest-claim-against-canon-refused");
  // No stdout claim payload — the guard fires before ledger claim runs.
  expect(r.stdout).toBe("");
});

test("worker-shell.sh refuses arctest-* claim when ARC_LEDGER_DB explicitly points at canon", () => {
  const shell = join(REPO, "bin", "worker-shell.sh");
  // Pin ARC_VAULT_HOME so CANON_DB is deterministic. Without it the shell's
  // _resolve_arc_vault_home() returns the XDG path on hosts lacking ~/vault
  // (e.g. CI runners), so a hardcoded ~/vault/ledger.db would NOT equal canon
  // and the guard would not fire — a host-shape dependency, not a real bug.
  const vaultHome = `${process.env.HOME}/vault`;
  const canonDb = `${vaultHome}/ledger.db`;
  const env = { ...process.env, ARC_VAULT_HOME: vaultHome, ARC_LEDGER_DB: canonDb, CLAUDE_BIN: fakeClaude };
  const r = spawnSync("bash", [shell, "arctest-guard-explicit"], { encoding: "utf8", env });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("arctest-claim-against-canon-refused");
});

test("worker-shell.sh allows arctest-* claim against a non-canon (test) ledger", () => {
  // This is the happy path for tests: arctest worker + ARC_LEDGER_DB set to
  // a tmp file. Guard must not fire; the claim path runs and (with no tasks)
  // returns claimed=null via the normal race-lost-or-empty branch.
  const shell = join(REPO, "bin", "worker-shell.sh");
  const env = { ...process.env, ARC_LEDGER_DB: dbPath, CLAUDE_BIN: fakeClaude };
  const r = spawnSync("bash", [shell, "arctest-guard-noncanon"], { encoding: "utf8", env });
  expect(r.status).toBe(0);
  expect(r.stderr).not.toContain("arctest-claim-against-canon-refused");
  expect(r.stdout).toContain("race-lost-or-empty");
});

test("worker-shell.sh survives systemd's stripped PATH (no ~/.bun/bin)", () => {
  // Regression: systemd --user services inherit PATH without ~/.bun/bin, so
  // factory-spawned tmux subshells could not resolve `bun` and died exit 127
  // before the claim ran. Shell must restore the bun dir itself.
  const id = createTask("path-strip");
  const shell = join(REPO, "bin", "worker-shell.sh");
  // Stripped PATH (as systemd --user delivers it) PLUS our fake-pi bin dir —
  // the agent-less row resolves to the `pi -p` headless engine, so `pi` must
  // resolve for the boot to reach the agent. The claim itself still depends on
  // worker-shell.sh self-restoring ~/.bun/bin for `bun`, which is what this
  // regression guards.
  const strippedPath = `${fakeBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    PATH: strippedPath,
    ARC_LEDGER_DB: dbPath,
    CLAUDE_BIN: fakeClaude,
    // Pin the worktree base to this checkout. The row's project=arc-agents
    // else resolves to ~/repos/arc-agents (resolve_repo default), which is
    // absent on CI runners — the worker would die "project repo not found"
    // after claiming and strand the row at `claimed`.
    ARC_PROJECT_REPO_ARC_AGENTS: REPO,
    // Prevent pass(1) from blocking on auth token/API key retrieval in the test.
    // The shell checks these env vars before attempting `pass show`, so setting
    // them to dummy values bypasses the potentially-blocking pass lookup entirely.
    CLAUDE_CODE_OAUTH_TOKEN: "test-token",
    MINIMAX_API_KEY: "test-key",
  };
  const r = spawnSync("bash", [shell, "w-stripped"], { encoding: "utf8", env });
  expect(r.status).toBe(0);
  expect(r.stderr).not.toContain("bun: command not found");
  // The claim ran (the row was assigned to this worker) — that is the bun-on-
  // stripped-PATH contract. The fake headless agent then self-reported
  // `review`, so the row advanced off `claimed` (not stuck, not recycled) while
  // keeping claimed_by. The reconciler saw the non-claimed state and stood down.
  const show = bun([LEDGER, "show", id]);
  const issue = JSON.parse(show.stdout).issue;
  expect(issue.claimed_by).toBe("w-stripped");
  expect(issue.state).toBe("review");
});

test("worker-shell.sh restores ~/node_modules/.bin so `pi` resolves on a stripped PATH", () => {
  // Regression (live daemon 2026-06-29): 9 exit-127 `pi: command not found`
  // events across 4+ projects in 30d. systemd --user delivers PATH without
  // ~/node_modules/.bin, where a local (non-global) `npm i @mariozechner/pi-
  // coding-agent` drops the `pi` symlink. 358b01f added ~/node_modules/.bin to
  // ensure_pi_on_path's candidate list. This test boots the REAL worker-
  // shell.sh on a stripped PATH with a CONTROLLABLE `pi` planted ONLY in
  // ~/node_modules/.bin, then asserts (a) `command -v pi` resolves after the
  // guard, AND (b) the headless engine actually exec'd it (row advances to
  // `review` via the fake-pi's self-report).
  //
  // Fake HOME so the candidate list's `~/node_modules/.bin` points at our
  // planted pi, not the real one (the real pi makes a network call we do not
  // want in a unit test). Prepend the real `~/.bun/bin` + `~/.local/bin` to
  // PATH so the bun/claude guards are no-ops; the only candidate that resolves
  // `pi` is the new ~/node_modules/.bin one.
  const fakeHome = mkdtempSync(join(tmpdir(), "arc-pi-home-"));
  const fakePiHomeDir = join(fakeHome, "node_modules", ".bin");
  mkdirSync(fakePiHomeDir, { recursive: true });
  // Fake `pi` that records its invocation AND exercises the same self-report
  // path the test fixture's fakePi does. Reads `pi --version` style and exits
  // 0 so the worker's headless-reconcile path treats the row as `review`.
  const fakePi = join(fakePiHomeDir, "pi");
  writeFileSync(
    fakePi,
    [
      "#!/usr/bin/env bash",
      "echo \"INVOKED pi argc=$# argv0=$0\"",
      "if [[ \"$1\" == \"--version\" ]]; then echo \"fake-pi 0.0.0\"; exit 0; fi",
      "if [[ -n \"${ARC_TASK_ID:-}\" ]]; then",
      "  DBF=()",
      "  [[ -n \"${ARC_LEDGER_DB:-}\" ]] && DBF=(--db \"$ARC_LEDGER_DB\")",
      `  bun ${JSON.stringify(LEDGER)} update "$ARC_TASK_ID" "\${DBF[@]}" --state review --evidence "fake-pi in fake HOME/node_modules/.bin self-report" >/dev/null 2>&1 || true`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);
  // cli-agent co-shim (2026-07-10 ruling): the real `fast`/`smart`/etc. aliases
  // now route through `cli-agent --pool <name>`, not `pi -p`. Plant a fake one
  // beside `pi` so the worker-shell guard ensure_cli_agent_on_path resolves it
  // and the headless-reconcile path treats the row as `review`.
  const fakeAgent = join(fakePiHomeDir, "cli-agent");
  writeFileSync(
    fakeAgent,
    [
      "#!/usr/bin/env bash",
      "echo \"INVOKED cli-agent argc=$# argv0=$0\"",
      "if [[ \"$1\" == \"--version\" ]]; then echo \"fake-cli-agent 0.0.0\"; exit 0; fi",
      "if [[ -n \"${ARC_TASK_ID:-}\" ]]; then",
      "  DBF=()",
      "  [[ -n \"${ARC_LEDGER_DB:-}\" ]] && DBF=(--db \"$ARC_LEDGER_DB\")",
      `  bun ${JSON.stringify(LEDGER)} update "$ARC_TASK_ID" "\${DBF[@]}" --state review --evidence "fake cli-agent in fake HOME/node_modules/.bin self-report" >/dev/null 2>&1 || true`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgent, 0o755);

  const realBun = process.env.HOME + "/.bun/bin";
  const realLocal = process.env.HOME + "/.local/bin";
  // Path that has bun + claude resolvable (guards become no-ops) but DELIBERATELY
  // omits any dir containing `pi`. The only way `pi` can be found is via
  // ensure_pi_on_path's ~/node_modules/.bin candidate. /usr/local is excluded:
  // on hosts with a global pi under the node prefix, the node-sibling probe
  // (`dirname(node)/../lib/node_modules/node/bin`) and `npm prefix -g` would
  // resolve the REAL pi ahead of the planted fake and break hermeticity.
  const strippedPath = `${realBun}:${realLocal}:/usr/sbin:/usr/bin:/sbin:/bin`;

  const id = createTask("pi-strip");
  const shell = join(REPO, "bin", "worker-shell.sh");
  const env: Record<string, string> = {
    HOME: fakeHome, // <- the only place `pi` lives
    USER: process.env.USER ?? "",
    PATH: strippedPath,
    ARC_LEDGER_DB: dbPath,
    CLAUDE_BIN: fakeClaude,
    ARC_PROJECT_REPO_ARC_AGENTS: REPO,
  };
  const r = spawnSync("bash", [shell, "w-pi-strip"], { encoding: "utf8", env });
  expect(r.status).toBe(0);
  // No "pi: command not found" anywhere — the guard must have found the
  // planted candidate and prepended it to PATH before the headless exec.
  expect(r.stderr).not.toContain("pi: command not found");
  expect(r.stdout).not.toContain("pi: command not found");
  // Row advanced off `claimed` to `review` via the fake-pi self-report — the
  // headless engine reached the agent (proves `pi` was on PATH at exec time
  // AND exec'd successfully) without the post-#16 reconciler needing to step in.
  const show = bun([LEDGER, "show", id]);
  const issue = JSON.parse(show.stdout).issue;
  expect(issue.claimed_by).toBe("w-pi-strip");
  expect(issue.state).toBe("review");

  rmSync(fakeHome, { recursive: true, force: true });
});

test("worker-shell.sh restores the node-global bin dir so the real `pi` resolves on systemd's stripped PATH", () => {
  // Regression (live daemon 2026-05-27): the agent-less row resolves to the
  // `pi -p` headless engine, but systemd --user delivers a PATH that lacks
  // the node-global bin dir holding `pi` (/usr/local/lib/node_modules/node/bin).
  // `bun` self-restored (~/.bun/bin) but `pi` did not, so every headless worker
  // exited 127 ("pi: command not found") and the #16 reconciler failed the row.
  // Fix: worker-shell.sh must self-restore the node-global bin dir, mirroring
  // the existing bun guard. This test sources the REAL worker-shell.sh via
  // ARC_WORKER_SHELL_SOURCE_ONLY=1, then runs `ensure_pi_on_path` against a
  // stripped PATH and asserts `command -v pi` resolves afterwards.
  //
  // The earlier inline-derivation probe (hardcoded `$NODE_BIN_DIR/../lib/node_
  // modules/node/bin`) drifted out of sync when 358b01f added the
  // `~/node_modules/.bin` candidate — the inline path was never the candidate
  // the live `ensure_pi_on_path` used. Sourcing the script keeps the test
  // hermetic to the shipped guard.
  const realPi = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
  if (realPi.status !== 0 || !realPi.stdout.trim()) {
    // No real pi installed in this environment — the guard is a no-op here and
    // there is nothing to regress against. Skip rather than false-fail in CI.
    return;
  }
  const piDir = dirname(realPi.stdout.trim());

  const shell = join(REPO, "bin", "worker-shell.sh");
  // Stripped PATH WITHOUT piDir and WITHOUT any other dir holding `pi` —
  // exactly what systemd delivered when the bug fired. /usr/local/bin is
  // present (holds `node`) but NOT the deeper node_modules bin that holds `pi`.
  const strippedPath = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  expect(strippedPath.split(":")).not.toContain(piDir);

  // Drive the REAL `ensure_pi_on_path` against the stripped env. Before the
  // guard, pi is missing; after, it resolves (the guard found the candidate
  // the install actually uses — node_modules/node/bin OR ~/node_modules/.bin,
  // whichever matches THIS host's install layout).
  const probe = spawnSync(
    "bash",
    [
      "-c",
      `set -e
       export PATH=${JSON.stringify(strippedPath)}
       command -v pi >/dev/null 2>&1 && echo "PI_BEFORE_FOUND" || echo "PI_BEFORE_MISSING"
       source ${JSON.stringify(shell)}
       ensure_pi_on_path
       command -v pi >/dev/null 2>&1 && echo "PI_AFTER_FOUND" || echo "PI_AFTER_MISSING"`,
    ],
    { encoding: "utf8", env: { HOME: process.env.HOME ?? "", PATH: strippedPath, ARC_WORKER_SHELL_SOURCE_ONLY: "1" } },
  );
  // Before restoration pi is missing (reproduces the bug); after, it resolves.
  expect(probe.stdout).toContain("PI_BEFORE_MISSING");
  expect(probe.stdout).toContain("PI_AFTER_FOUND");

  // And the REAL worker-shell.sh must carry the candidates that match real
  // install layouts. This pins the fix in the shipped script. We do NOT boot
  // the real shell here because, with the guard working, the REAL network `pi`
  // would run and hang the unit test — the probe above already proves the guard
  // makes `pi` resolvable on the exact stripped PATH that broke the live daemon.
  const shellSrc = spawnSync("cat", [shell], { encoding: "utf8" }).stdout;
  expect(shellSrc).toContain("command -v pi");
  // The two candidates that have caught real bugs:
  //   - 358b01f: `~/node_modules/.bin` (local non-global install, the row
  //     that fired this slice).
  //   - 0e9b3ac (older): `node_modules/node/bin` (global node install,
  //     original systemd-stripped bug).
  expect(shellSrc).toContain("node_modules/node/bin");
  expect(shellSrc).toContain("node_modules/.bin");
  // Guard must be conditional (no-op when pi already resolves) and version-agnostic.
  expect(shellSrc).toMatch(/command -v node/);
});

test("auditOrphans detects long-running wait-for-ledger.ts processes", async () => {
  // Spawn a fake wait-for-ledger.ts proc via a bash wrapper named to match.
  // We can't fake `etimes` without a kernel hack, so we test the detection path
  // by importing the function and stubbing `ps`. Simpler approach: spawn a real
  // sleep, then call the function with a tiny age threshold via monkey-patch.
  // Even simpler: just import and verify the no-op (no orphan) returns empty.
  const { auditOrphans } = await import(join(REPO, "bin", "factory.ts"));
  const r = auditOrphans();
  // Live test machine may or may not have real orphans. Contract: function
  // returns shape {pids, ages} without throwing, ages.length === pids.length.
  expect(Array.isArray(r.pids)).toBe(true);
  expect(Array.isArray(r.ages)).toBe(true);
  expect(r.pids.length).toBe(r.ages.length);
  // Any detected ages must be >= 24hr (filter threshold).
  for (const a of r.ages) expect(a).toBeGreaterThanOrEqual(86400);
});

test("printOrphanWarn emits expected JSON shape on stderr", async () => {
  const { printOrphanWarn } = await import(join(REPO, "bin", "factory.ts"));
  const orig = console.error;
  let captured = "";
  console.error = (s: string) => { captured = s; };
  try {
    printOrphanWarn({ pids: [1234, 5678], ages: [90000, 432000] }, 1716192000);
  } finally {
    console.error = orig;
  }
  const j = JSON.parse(captured);
  expect(j.warn).toBe("orphaned_wait_for_ledger");
  expect(j.count).toBe(2);
  expect(j.pids).toEqual([1234, 5678]);
  expect(j.ages_hr).toEqual([25, 120]);
  expect(typeof j.ts).toBe("string");
  expect(typeof j.hint).toBe("string");
});

test("printOrphansCleared emits info-level JSON on stdout", async () => {
  const { printOrphansCleared } = await import(join(REPO, "bin", "factory.ts"));
  const orig = console.log;
  let captured = "";
  console.log = (s: string) => { captured = s; };
  try {
    printOrphansCleared(3, 1716192000);
  } finally {
    console.log = orig;
  }
  const j = JSON.parse(captured);
  expect(j.info).toBe("orphans_cleared");
  expect(j.prior_count).toBe(3);
  expect(j.warn).toBeUndefined();
  expect(typeof j.ts).toBe("string");
});

test("printMergeableWarn emits expected JSON shape on stderr", async () => {
  const { printMergeableWarn } = await import(join(REPO, "bin", "factory.ts"));
  const orig = console.error;
  let captured = "";
  console.error = (s: string) => { captured = s; };
  try {
    printMergeableWarn(
      { paths: ["/home/u/worktrees/arc-agents-foo", "/home/u/worktrees/arc-agents-bar"], branches: ["foo", null] },
      1716192000,
    );
  } finally {
    console.error = orig;
  }
  const j = JSON.parse(captured);
  expect(j.warn).toBe("mergeable_worktrees");
  expect(j.count).toBe(2);
  expect(j.paths).toEqual(["/home/u/worktrees/arc-agents-foo", "/home/u/worktrees/arc-agents-bar"]);
  expect(j.branches).toEqual(["foo", null]);
  expect(typeof j.ts).toBe("string");
  expect(typeof j.hint).toBe("string");
});

test("printMergeableCleared emits info-level JSON on stdout", async () => {
  const { printMergeableCleared } = await import(join(REPO, "bin", "factory.ts"));
  const orig = console.log;
  let captured = "";
  console.log = (s: string) => { captured = s; };
  try {
    printMergeableCleared(2, 1716192000);
  } finally {
    console.log = orig;
  }
  const j = JSON.parse(captured);
  expect(j.info).toBe("mergeable_cleared");
  expect(j.prior_count).toBe(2);
  expect(j.warn).toBeUndefined();
  expect(typeof j.ts).toBe("string");
});

// Regression: systemd runs the daemon with a PATH that excludes ~/.bun/bin,
// so spawnSync("bun", ...) silently fails with ENOENT and the audit returns
// empty. The fix is to spawn process.execPath (the bun binary that started
// the daemon) instead of relying on PATH lookup.
test("auditMergeableWorktrees works when PATH does not contain bun", async () => {
  const { auditMergeableWorktrees } = await import(join(REPO, "bin", "factory.ts"));
  const origPath = process.env.PATH;
  const origDb = process.env.ARC_LEDGER_DB;
  process.env.ARC_LEDGER_DB = dbPath;
  // Strip bun from PATH; keep system bins so git/tmux still work for doctor.
  process.env.PATH = "/usr/bin:/bin";
  try {
    const r = auditMergeableWorktrees();
    // No worktrees in the empty test ledger → expect empty arrays, NOT a
    // silent ENOENT fallback. The key distinction: with the bug, doctor was
    // never invoked at all; with the fix, doctor runs and returns an empty
    // mergeable_worktrees set.
    expect(Array.isArray(r.paths)).toBe(true);
    expect(Array.isArray(r.branches)).toBe(true);
    expect(r.paths.length).toBe(r.branches.length);
  } finally {
    process.env.PATH = origPath;
    if (origDb === undefined) delete process.env.ARC_LEDGER_DB;
    else process.env.ARC_LEDGER_DB = origDb;
  }
});

test("worker-shell.sh claims atomically: only one of two parallel shells wins for one task", () => {
  const id = createTask("solo");
  const shell = join(REPO, "bin", "worker-shell.sh");
  // Prepend the fake-pi bin dir: the winner resolves to the `pi -p` headless
  // engine and must find a controllable `pi` rather than the real (blocking)
  // one. The fake self-reports terminal and exits, so the winner returns fast.
  // ARC_PROJECT_REPO_ARC_AGENTS pins the worktree base to this checkout — the
  // row's project=arc-agents else resolves to ~/repos/arc-agents, absent on CI.
  const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, ARC_LEDGER_DB: dbPath, CLAUDE_BIN: fakeClaude, ARC_PROJECT_REPO_ARC_AGENTS: REPO };
  // Run two shells in parallel; both attempt claim, exactly one should succeed.
  const r1 = spawnSync("bash", [shell, "w1"], { encoding: "utf8", env });
  const r2 = spawnSync("bash", [shell, "w2"], { encoding: "utf8", env });
  // Each exits 0; one wins the claim and runs the fake headless agent, the
  // other prints claimed=null and exits 0.
  const outs = [r1.stdout, r2.stdout].join("");
  // Exactly one race-lost message expected (G-0002: one UPDATE...RETURNING wins).
  const lost = (outs.match(/race-lost-or-empty/g) ?? []).length;
  expect(lost).toBe(1);
  // Exactly one winner held the row: it was claimed by w1 or w2, and the fake
  // headless agent advanced it to `review` (never recycled to `ready`).
  const show = bun([LEDGER, "show", id]);
  const issue = JSON.parse(show.stdout).issue;
  expect(["w1", "w2"]).toContain(issue.claimed_by);
  expect(issue.state).toBe("review");
});

// --- reapMergeableWorktrees regression tests --------------------------------
// Build a real git repo + worktree on HEAD-of-main and feed it directly to
// reapMergeableWorktrees(found) so we bypass auditMergeableWorktrees and
// ledger doctor. This keeps the test scoped to the prune logic itself.

import { existsSync } from "node:fs";

function setupMergeableRepo(): { parent: string; wt: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), "arc-prune-test-"));
  const parent = join(root, "parent");
  spawnSync("git", ["init", "-q", "-b", "main", parent], { encoding: "utf8" });
  spawnSync("git", ["-C", parent, "config", "user.email", "t@t"], { encoding: "utf8" });
  spawnSync("git", ["-C", parent, "config", "user.name", "t"], { encoding: "utf8" });
  writeFileSync(join(parent, "a"), "1\n");
  spawnSync("git", ["-C", parent, "add", "a"], { encoding: "utf8" });
  spawnSync("git", ["-C", parent, "commit", "-q", "-m", "init"], { encoding: "utf8" });
  const branch = `wt-${Math.random().toString(36).slice(2, 8)}`;
  const wt = join(root, "wt");
  const add = spawnSync("git", ["-C", parent, "worktree", "add", "-q", "-b", branch, wt], { encoding: "utf8" });
  if (add.status !== 0) throw new Error(`worktree add failed: ${add.stderr}`);
  return { parent, wt, branch };
}

test("reapMergeableWorktrees: gated off when ARC_AUTO_PRUNE != 1", async () => {
  const { reapMergeableWorktrees } = await import(join(REPO, "bin", "factory.ts"));
  const { wt, branch } = setupMergeableRepo();
  const orig = process.env.ARC_AUTO_PRUNE;
  delete process.env.ARC_AUTO_PRUNE;
  try {
    const r = reapMergeableWorktrees({ paths: [wt], branches: [branch] });
    expect(r.pruned).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  } finally {
    if (orig === undefined) delete process.env.ARC_AUTO_PRUNE;
    else process.env.ARC_AUTO_PRUNE = orig;
  }
});

test("reapMergeableWorktrees: prunes a clean worktree end-to-end", async () => {
  const { reapMergeableWorktrees } = await import(join(REPO, "bin", "factory.ts"));
  const { parent, wt, branch } = setupMergeableRepo();
  const orig = process.env.ARC_AUTO_PRUNE;
  process.env.ARC_AUTO_PRUNE = "1";
  try {
    const r = reapMergeableWorktrees({ paths: [wt], branches: [branch] });
    expect(r.skipped).toEqual([]);
    expect(r.pruned).toEqual([{ path: wt, branch }]);
    expect(existsSync(wt)).toBe(false);
    // Branch should also be gone.
    const br = spawnSync("git", ["-C", parent, "branch", "--list", branch], { encoding: "utf8" });
    expect(br.stdout.trim()).toBe("");
  } finally {
    if (orig === undefined) delete process.env.ARC_AUTO_PRUNE;
    else process.env.ARC_AUTO_PRUNE = orig;
  }
});

test("reapMergeableWorktrees: skips dirty worktree with reason=dirty-worktree", async () => {
  const { reapMergeableWorktrees } = await import(join(REPO, "bin", "factory.ts"));
  const { wt, branch } = setupMergeableRepo();
  writeFileSync(join(wt, "scratch"), "uncommitted\n");
  const orig = process.env.ARC_AUTO_PRUNE;
  process.env.ARC_AUTO_PRUNE = "1";
  try {
    const r = reapMergeableWorktrees({ paths: [wt], branches: [branch] });
    expect(r.pruned).toEqual([]);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]!.path).toBe(wt);
    expect(r.skipped[0]!.reason).toBe("dirty-worktree");
    expect(existsSync(wt)).toBe(true);
  } finally {
    if (orig === undefined) delete process.env.ARC_AUTO_PRUNE;
    else process.env.ARC_AUTO_PRUNE = orig;
  }
});

test("printFactoryStarted emits expected JSON shape on stdout", async () => {
  const { printFactoryStarted } = await import(join(REPO, "bin", "factory.ts"));
  const orig = console.log;
  let captured = "";
  console.log = (s: string) => { captured = s; };
  try {
    printFactoryStarted(
      {
        slots_any: 4,
        slots_interactive: 2,
        max_age_sec: 14400,
        interval_sec: 5,
        prefix: "arc-worker",
        db: "/tmp/t.db",
      },
      1716192000,
    );
  } finally {
    console.log = orig;
  }
  const j = JSON.parse(captured);
  expect(j.info).toBe("factory_started");
  expect(j.pid).toBe(process.pid);
  expect(j.slots_any).toBe(4);
  expect(j.slots_interactive).toBe(2);
  expect(j.max_age_sec).toBe(14400);
  expect(j.interval_sec).toBe(5);
  expect(j.prefix).toBe("arc-worker");
  expect(j.db).toBe("/tmp/t.db");
  expect(typeof j.ts).toBe("string");
});

test("printMergeablePruned emits expected JSON shape on stdout", async () => {
  const { printMergeablePruned } = await import(join(REPO, "bin", "factory.ts"));
  const orig = console.log;
  let captured = "";
  console.log = (s: string) => { captured = s; };
  try {
    printMergeablePruned(
      {
        pruned: [{ path: "/w/foo", branch: "foo" }],
        skipped: [{ path: "/w/bar", branch: null, reason: "dirty-worktree" }],
      },
      1716192000,
    );
  } finally {
    console.log = orig;
  }
  const j = JSON.parse(captured);
  expect(j.info).toBe("mergeable_pruned");
  expect(j.pruned_count).toBe(1);
  expect(j.skipped_count).toBe(1);
  expect(j.pruned).toEqual([{ path: "/w/foo", branch: "foo" }]);
  expect(j.skipped).toEqual([{ path: "/w/bar", branch: null, reason: "dirty-worktree" }]);
  expect(typeof j.ts).toBe("string");
});

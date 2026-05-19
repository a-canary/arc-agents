import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../src/ledger/migrate";

const cli = new URL("./arc-ux.ts", import.meta.url).pathname;

let dir: string;
let dbPath: string;
let cfgPath: string;

const FULL_CFG = `
modules:
  arc-tui:
    cli: arc-tui
    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      text/diff: native
      image/png: ascii-degrade
      chart/vega-lite: ascii-degrade
      diagram/mermaid: ascii-degrade
      table/rows: native
    can_retract: true
  arc-webui:
    cli: arc-webui
    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]
    renders:
      text/markdown: native
      text/diff: native
      image/png: native
      chart/vega-lite: native
      diagram/mermaid: native
      table/rows: native
    can_retract: true
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arc-ux-"));
  dbPath = join(dir, "t.db");
  cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, FULL_CFG);
  const db = new Database(dbPath);
  migrate(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function heartbeat(name: string) {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES (?, strftime('%s','now'))
     ON CONFLICT(module_name) DO UPDATE SET last_beat=excluded.last_beat`,
    [name],
  );
  db.close();
}

function rows<T = Record<string, unknown>>(sql: string): T[] {
  const db = new Database(dbPath);
  const r = db.query<T, []>(sql).all();
  db.close();
  return r;
}

async function runUx(args: string[], env: Record<string, string> = {}) {
  return await $`bun ${cli} ${args}`
    .env({ ...process.env, ARC_LEDGER_DB: dbPath, ARC_CONFIG: cfgPath, ...env })
    .quiet()
    .nothrow();
}

test("ask-text class=taste requires --recommended", async () => {
  heartbeat("arc-tui");
  const r = await runUx(["ask-text", "--prompt", "hi"]);
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("recommended");
});

test("ask-choice taste returns recommendation immediately and inserts row + deliveries", async () => {
  heartbeat("arc-tui");
  heartbeat("arc-webui");
  const r = await runUx([
    "ask-choice",
    "--prompt", "pick color",
    "--options", "blue,green,red",
    "--recommended", "blue",
  ]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.answer).toBe("blue");
  expect(out.speculative).toBe(true);
  expect(typeof out.id).toBe("string");

  const prompts = rows<{ id: string; class: string; state: string; recommended: string }>(
    "SELECT id, class, state, recommended FROM hitl_prompts",
  );
  expect(prompts.length).toBe(1);
  expect(prompts[0]!.class).toBe("taste");
  expect(prompts[0]!.state).toBe("open");
  expect(prompts[0]!.recommended).toBe("blue");

  const dels = rows<{ module_name: string; state: string }>(
    "SELECT module_name, state FROM hitl_deliveries ORDER BY module_name",
  );
  expect(dels.map((d) => d.module_name)).toEqual(["arc-tui", "arc-webui"]);
  expect(dels.every((d) => d.state === "pending")).toBe(true);
});

test("no alive module -> exit 3, spawn no row in hitl_prompts", async () => {
  // No heartbeats inserted.
  const r = await runUx([
    "ask-choice",
    "--prompt", "x",
    "--options", "a,b",
    "--recommended", "a",
  ]);
  expect(r.exitCode).toBe(3);
  expect(r.stderr.toString()).toContain("no alive UX module");
  const prompts = rows("SELECT * FROM hitl_prompts");
  expect(prompts.length).toBe(0);
});

test("repeated bootstrap spawns at most one install task (idempotent)", async () => {
  // No heartbeats; two back-to-back asks should both refuse and both nudge the
  // bookie to spawn the install task — but the install task itself must dedupe.
  // mintId appends a random suffix on PK collision (src/ledger/db.ts:29), so
  // without an explicit pre-check the bootstrap path generates a new row per
  // call, flooding the queue.
  for (let i = 0; i < 3; i++) {
    const r = await runUx([
      "ask-choice",
      "--prompt", "x",
      "--options", "a,b",
      "--recommended", "a",
    ]);
    expect(r.exitCode).toBe(3);
  }
  const installs = rows<{ id: string }>(
    "SELECT id FROM issues WHERE title='Install a UX surface module'",
  );
  expect(installs.length).toBe(1);
});

test("class=impact from worker role exits 4", async () => {
  heartbeat("arc-tui");
  const r = await runUx(
    ["ask-text", "--prompt", "big call", "--class", "impact"],
    { ARC_ROLE: "developer" },
  );
  expect(r.exitCode).toBe(4);
  expect(r.stderr.toString()).toContain("interviewer");
});

test("class=impact from interviewer blocks then returns answer", async () => {
  heartbeat("arc-tui");
  // Spawn arc-ux in background; have a watcher answer the prompt after a tick.
  const proc = Bun.spawn(
    ["bun", cli, "ask-text", "--prompt", "ship it?", "--class", "impact"],
    {
      env: { ...process.env, ARC_LEDGER_DB: dbPath, ARC_CONFIG: cfgPath, ARC_ROLE: "interviewer" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Poll for the row to appear, then answer it.
  let id: string | null = null;
  for (let i = 0; i < 40; i++) {
    const got = rows<{ id: string }>("SELECT id FROM hitl_prompts");
    if (got.length > 0) { id = got[0]!.id; break; }
    await Bun.sleep(100);
  }
  expect(id).not.toBeNull();
  const db = new Database(dbPath);
  db.run(
    `UPDATE hitl_prompts SET state='answered', answer='yes', answered_by='arc-tui',
       answered_at=strftime('%s','now') WHERE id=?`,
    [id!],
  );
  db.close();

  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const out = JSON.parse(stdout);
  expect(out.answer).toBe("yes");
  expect(out.speculative).toBe(false);
});

test("notify broadcasts to all alive modules, exits 0 without waiting", async () => {
  heartbeat("arc-tui");
  heartbeat("arc-webui");
  const r = await runUx(["notify", "--message", "hello", "--level", "warn"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(new Set(out.broadcast)).toEqual(new Set(["arc-tui", "arc-webui"]));
  const dels = rows<{ module_name: string }>("SELECT module_name FROM hitl_deliveries");
  expect(dels.length).toBe(2);
});

test("show-artifact succeeds without --recommended (ack-only, no answer to recommend)", async () => {
  heartbeat("arc-tui");
  const r = await runUx([
    "show-artifact", "--caption", "look", "--artifact", "text/markdown:hi",
  ]);
  expect(r.exitCode).toBe(0);
  const got = rows<{ kind: string; recommended: string | null; state: string }>(
    "SELECT kind, recommended, state FROM hitl_prompts",
  );
  expect(got.length).toBe(1);
  expect(got[0]!.kind).toBe("show_artifact");
  expect(got[0]!.state).toBe("open");
});

test("ask-choice requires >=2 options", async () => {
  heartbeat("arc-tui");
  const r = await runUx([
    "ask-choice", "--prompt", "x", "--options", "only-one", "--recommended", "only-one",
  ]);
  expect(r.exitCode).toBe(2);
});

test("stale heartbeat (>300s) is treated as not alive", async () => {
  // Insert a stale heartbeat manually.
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES ('arc-tui', strftime('%s','now') - 1000)`,
  );
  db.close();
  const r = await runUx([
    "ask-choice", "--prompt", "x", "--options", "a,b", "--recommended", "a",
  ]);
  expect(r.exitCode).toBe(3);
});

test("anchor captured for taste prompts when run inside a git repo", async () => {
  heartbeat("arc-tui");
  const r = await runUx([
    "ask-choice", "--prompt", "x", "--options", "a,b", "--recommended", "a",
  ]);
  expect(r.exitCode).toBe(0);
  // arc-agents itself is a git repo, so gitAnchor() should populate fields.
  const got = rows<{ anchor_commit: string | null; anchor_branch: string | null }>(
    "SELECT anchor_commit, anchor_branch FROM hitl_prompts",
  );
  expect(got[0]!.anchor_commit).toMatch(/^[0-9a-f]{40}$/);
  expect(got[0]!.anchor_branch).toBeTruthy();
});

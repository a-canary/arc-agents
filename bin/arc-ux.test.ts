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

test("thread-merge writes merged_into on existing subscription rows", async () => {
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO thread_subscriptions (thread_id, subscriber) VALUES (?, ?)`,
    ["t-src", "alice"],
  );
  db.run(
    `INSERT INTO thread_subscriptions (thread_id, subscriber) VALUES (?, ?)`,
    ["t-src", "bob"],
  );
  db.close();
  const r = await runUx(["thread-merge", "--src", "t-src", "--dest", "t-dest"]);
  expect(r.exitCode).toBe(0);
  const got = rows<{ subscriber: string; merged_into: string | null }>(
    "SELECT subscriber, merged_into FROM thread_subscriptions WHERE thread_id='t-src' ORDER BY subscriber",
  );
  expect(got).toEqual([
    { subscriber: "alice", merged_into: "t-dest" },
    { subscriber: "bob", merged_into: "t-dest" },
  ]);
});

test("thread-merge inserts marker row when no subscriptions exist", async () => {
  const r = await runUx(["thread-merge", "--src", "empty-src", "--dest", "empty-dest"]);
  expect(r.exitCode).toBe(0);
  const got = rows<{ thread_id: string; subscriber: string; merged_into: string | null }>(
    "SELECT thread_id, subscriber, merged_into FROM thread_subscriptions WHERE thread_id='empty-src'",
  );
  expect(got).toEqual([
    { thread_id: "empty-src", subscriber: "__merge_marker__", merged_into: "empty-dest" },
  ]);
});

test("thread-merge rejects identical src and dest", async () => {
  const r = await runUx(["thread-merge", "--src", "same", "--dest", "same"]);
  expect(r.exitCode).toBe(2);
});

test("thread_subscriptions schema present with merged_into column and index", async () => {
  const cols = rows<{ name: string }>("PRAGMA table_info(thread_subscriptions)");
  const names = cols.map((c) => c.name);
  expect(names).toContain("thread_id");
  expect(names).toContain("subscriber");
  expect(names).toContain("merged_into");
  const idx = rows<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='thread_subscriptions'",
  );
  expect(idx.some((r) => r.name === "idx_thread_subs_merged_into")).toBe(true);
});

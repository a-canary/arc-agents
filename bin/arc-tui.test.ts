import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "../src/ledger/migrate";

const cli = new URL("./arc-tui.ts", import.meta.url).pathname;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arc-tui-"));
  dbPath = join(dir, "t.db");
  const db = new Database(dbPath);
  migrate(db);
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function db(): Database {
  return new Database(dbPath);
}

async function runTui(args: string[]) {
  return await $`bun ${cli} ${args}`
    .env({ ...process.env, ARC_LEDGER_DB: dbPath })
    .quiet()
    .nothrow();
}

function insertPrompt(id: string, kind = "ask_choice", payload = { prompt: "pick", options: ["a", "b"], artifacts: [] }) {
  const d = db();
  d.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, state, timeout_sec)
     VALUES (?, ?, 'taste', ?, 'a', 'open', 60)`,
    [id, kind, JSON.stringify(payload)],
  );
  d.run(
    `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES (?, 'arc-tui', 'pending')`,
    [id],
  );
  d.close();
}

test("heartbeat upserts ux_heartbeats row", async () => {
  const r = await runTui(["heartbeat"]);
  expect(r.exitCode).toBe(0);
  const d = db();
  const got = d.query<{ module_name: string; last_beat: number }, []>(
    "SELECT module_name, last_beat FROM ux_heartbeats",
  ).all();
  d.close();
  expect(got.length).toBe(1);
  expect(got[0]!.module_name).toBe("arc-tui");
  expect(got[0]!.last_beat).toBeGreaterThan(0);
});

test("heartbeat is idempotent (upsert, not insert)", async () => {
  await runTui(["heartbeat"]);
  await runTui(["heartbeat"]);
  const d = db();
  const n = d.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM ux_heartbeats").get();
  d.close();
  expect(n!.c).toBe(1);
});

test("answer wins atomically: sets state=answered, answered_by=arc-tui", async () => {
  insertPrompt("p1");
  const r = await runTui(["answer", "p1", "b"]);
  expect(r.exitCode).toBe(0);
  const d = db();
  const got = d.query<{ state: string; answer: string; answered_by: string }, []>(
    "SELECT state, answer, answered_by FROM hitl_prompts WHERE id='p1'",
  ).get();
  d.close();
  expect(got!.state).toBe("answered");
  expect(got!.answer).toBe("b");
  expect(got!.answered_by).toBe("arc-tui");
});

test("answering already-answered prompt is a no-op (loser case), exits 3", async () => {
  insertPrompt("p2");
  const d = db();
  d.run(
    `UPDATE hitl_prompts SET state='answered', answer='other', answered_by='arc-webui',
       answered_at=strftime('%s','now') WHERE id='p2'`,
  );
  d.close();
  const r = await runTui(["answer", "p2", "a"]);
  expect(r.exitCode).toBe(3);
  const d2 = db();
  const got = d2.query<{ answered_by: string; answer: string }, []>(
    "SELECT answered_by, answer FROM hitl_prompts WHERE id='p2'",
  ).get();
  d2.close();
  expect(got!.answered_by).toBe("arc-webui"); // winner stays
  expect(got!.answer).toBe("other");
});

test("answer fires retract cascade on losing deliveries", async () => {
  insertPrompt("p3");
  const d = db();
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p3', 'arc-webui', 'delivered')`);
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p3', 'arc-discord', 'delivered')`);
  d.close();
  const r = await runTui(["answer", "p3", "a"]);
  expect(r.exitCode).toBe(0);
  const d2 = db();
  const got = d2.query<{ module_name: string; state: string }, []>(
    "SELECT module_name, state FROM hitl_deliveries WHERE prompt_id='p3' ORDER BY module_name",
  ).all();
  d2.close();
  const map = Object.fromEntries(got.map((r) => [r.module_name, r.state]));
  expect(map["arc-tui"]).toBe("delivered"); // winner — bumped from pending to delivered
  expect(map["arc-webui"]).toBe("retracted");
  expect(map["arc-discord"]).toBe("retracted");
});

test("list prints open prompts addressed to arc-tui as JSON lines", async () => {
  insertPrompt("p4", "ask_choice", { prompt: "pick color", options: ["blue", "red"], artifacts: [] });
  insertPrompt("p5", "ask_text", { prompt: "name?", options: [], artifacts: [] });
  // A prompt addressed to someone else — must not appear.
  const d = db();
  d.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, state, timeout_sec)
     VALUES ('px', 'ask_text', 'taste', '{"prompt":"x","artifacts":[]}', 'y', 'open', 60)`,
  );
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('px', 'arc-webui', 'pending')`);
  d.close();

  const r = await runTui(["list"]);
  expect(r.exitCode).toBe(0);
  const lines = r.stdout.toString().trim().split("\n").filter(Boolean);
  const ids = lines.map((l) => JSON.parse(l).id).sort();
  expect(ids).toEqual(["p4", "p5"]);
});

test("list ignores retracted and acked deliveries", async () => {
  insertPrompt("p6");
  const d = db();
  d.run(`UPDATE hitl_deliveries SET state='retracted' WHERE prompt_id='p6'`);
  d.close();
  const r = await runTui(["list"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString().trim()).toBe("");
});

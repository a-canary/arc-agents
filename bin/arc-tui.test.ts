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

test("refuses to answer when prompt is not addressed to arc-tui", async () => {
  // Open prompt delivered only to arc-webui — arc-tui must not be able to claim it.
  const d = db();
  d.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, state, timeout_sec)
     VALUES ('pother', 'ask_choice', 'taste', '{"prompt":"x","options":["a","b"],"artifacts":[]}', 'a', 'open', 60)`,
  );
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('pother', 'arc-webui', 'pending')`);
  d.close();
  const r = await runTui(["answer", "pother", "sneaky"]);
  expect(r.exitCode).toBe(3);
  const d2 = db();
  const got = d2.query<{ state: string; answer: string | null; answered_by: string | null }, []>(
    "SELECT state, answer, answered_by FROM hitl_prompts WHERE id='pother'",
  ).get();
  d2.close();
  expect(got!.state).toBe("open");
  expect(got!.answer).toBeNull();
  expect(got!.answered_by).toBeNull();
});

test("refuses to answer when delivery to arc-tui was already retracted", async () => {
  insertPrompt("pretr");
  const d = db();
  d.run(`UPDATE hitl_deliveries SET state='retracted' WHERE prompt_id='pretr' AND module_name='arc-tui'`);
  d.close();
  const r = await runTui(["answer", "pretr", "ignored"]);
  expect(r.exitCode).toBe(3);
});

test("list hides prompts whose expires_at has passed", async () => {
  // arc-ux.ts:292 expects a reconciler to flip expired prompts; none exists yet,
  // so arc-tui must filter them out at read-time. Otherwise operators see (and
  // can answer) prompts whose requesting worker has already given up.
  insertPrompt("pfresh");
  const d = db();
  d.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, state, timeout_sec, expires_at)
     VALUES ('pexp', 'ask_choice', 'taste', '{"prompt":"x","options":["a","b"],"artifacts":[]}', 'a', 'open', 60, strftime('%s','now') - 10)`,
  );
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('pexp', 'arc-tui', 'pending')`);
  d.close();

  const r = await runTui(["list"]);
  expect(r.exitCode).toBe(0);
  const ids = r.stdout.toString().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id).sort();
  expect(ids).toEqual(["pfresh"]);
});

test("answer refuses an expired prompt with exit 3", async () => {
  const d = db();
  d.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, state, timeout_sec, expires_at)
     VALUES ('pexp2', 'ask_choice', 'taste', '{"prompt":"x","options":["a","b"],"artifacts":[]}', 'a', 'open', 60, strftime('%s','now') - 10)`,
  );
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('pexp2', 'arc-tui', 'pending')`);
  d.close();
  const r = await runTui(["answer", "pexp2", "x"]);
  expect(r.exitCode).toBe(3);
  const d2 = db();
  const got = d2.query<{ state: string; answer: string | null; answered_by: string | null }, []>(
    "SELECT state, answer, answered_by FROM hitl_prompts WHERE id='pexp2'",
  ).get();
  d2.close();
  expect(got!.state).toBe("open");
  expect(got!.answer).toBeNull();
  expect(got!.answered_by).toBeNull();
});

test("list survives a malformed payload by surfacing _parse_error", async () => {
  insertPrompt("pgood");
  const d = db();
  d.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, state, timeout_sec)
     VALUES ('pbad', 'ask_text', 'taste', 'not-valid-json{{{', 'a', 'open', 60)`,
  );
  d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('pbad', 'arc-tui', 'pending')`);
  d.close();
  const r = await runTui(["list"]);
  expect(r.exitCode).toBe(0);
  const lines = r.stdout.toString().trim().split("\n").filter(Boolean);
  const byId: Record<string, { id: string; payload: { _parse_error?: string; _raw?: string } | unknown }> = {};
  for (const l of lines) {
    const obj = JSON.parse(l);
    byId[obj.id] = obj;
  }
  expect(Object.keys(byId).sort()).toEqual(["pbad", "pgood"]);
  const badPayload = byId.pbad!.payload as { _parse_error: string; _raw: string };
  expect(badPayload._parse_error).toBeDefined();
  expect(badPayload._raw).toBe("not-valid-json{{{");
});

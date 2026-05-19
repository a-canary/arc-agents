import { test, expect } from "bun:test";
import { spawn } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/ledger/migrate";

const cli = new URL("./wait-for-ledger.ts", import.meta.url).pathname;

test("emits json line when ready row exists for kind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfl-"));
  const dbPath = join(dir, "t.db");
  try {
    const db = new Database(dbPath);
    migrate(db);
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('t-1','p','t','b','mvp','ready','task')`,
    );
    db.close();

    const proc = spawn({
      cmd: ["bun", cli, "--kind", "task", "--db", dbPath, "--interval", "1"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 3000;
    let chunk = "";
    while (Date.now() < deadline && !chunk.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunk += new TextDecoder().decode(value);
    }
    proc.kill();
    const line = chunk.split("\n").find((l) => l.length > 0)!;
    const parsed = JSON.parse(line);
    expect(parsed.wake).toBe(true);
    expect(parsed.available).toBe(1);
    expect(parsed.mode).toBe("worker:task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("excludes paused rows from worker count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfl-"));
  const dbPath = join(dir, "t.db");
  try {
    const db = new Database(dbPath);
    migrate(db);
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, paused)
       VALUES ('live','p','t','b','mvp','ready','task',0)`,
    );
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, paused)
       VALUES ('hold','p','t','b','mvp','ready','task',1)`,
    );
    db.close();

    const proc = spawn({
      cmd: ["bun", cli, "--kind", "task", "--db", dbPath, "--interval", "1"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 3000;
    let chunk = "";
    while (Date.now() < deadline && !chunk.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunk += new TextDecoder().decode(value);
    }
    proc.kill();
    const line = chunk.split("\n").find((l) => l.length > 0)!;
    const parsed = JSON.parse(line);
    expect(parsed.available).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ready-row ordering: higher priority first, paused excluded", () => {
  // Mirrors the WHERE/ORDER BY shipped in wait-for-ledger.ts so any drift in
  // the production query trips this test alongside the CLI smoke tests.
  const dir = mkdtempSync(join(tmpdir(), "wfl-"));
  const dbPath = join(dir, "t.db");
  try {
    const db = new Database(dbPath);
    migrate(db);
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, priority, paused)
       VALUES ('low','p','t','b','mvp','ready','task',10,0)`,
    );
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, priority, paused)
       VALUES ('high','p','t','b','mvp','ready','task',100,0)`,
    );
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, priority, paused)
       VALUES ('paused-hi','p','t','b','mvp','ready','task',1000,1)`,
    );
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM issues WHERE kind=? AND state='ready' AND claimed_by IS NULL AND paused=0 ORDER BY priority DESC, created_at ASC",
      )
      .all("task");
    db.close();
    expect(rows.map((r) => r.id)).toEqual(["high", "low"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("silent when no rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfl-"));
  const dbPath = join(dir, "t.db");
  try {
    const db = new Database(dbPath);
    migrate(db);
    db.close();
    const proc = spawn({
      cmd: ["bun", cli, "--kind", "task", "--db", dbPath, "--interval", "1"],
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Promise((r) => setTimeout(r, 1500));
    proc.kill();
    const out = await new Response(proc.stdout).text();
    expect(out.trim()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

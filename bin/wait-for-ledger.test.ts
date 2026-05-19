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

test("interviewer mode only counts ready, unclaimed event rows from arc-chat/arc-encounter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wfl-"));
  const dbPath = join(dir, "t.db");
  try {
    const db = new Database(dbPath);
    migrate(db);
    // 1. Matches: kind=event, source_module=arc-chat, state=ready, claimed_by NULL.
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, source_module)
       VALUES ('match-1','p','t','b','mvp','ready','event','arc-chat')`,
    );
    // 2. Wrong source_module.
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, source_module)
       VALUES ('miss-mod','p','t','b','mvp','ready','event','arc-other')`,
    );
    // 3. Right shape but already claimed.
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, source_module, claimed_by)
       VALUES ('miss-claimed','p','t','b','mvp','claimed','event','arc-encounter','w-1')`,
    );
    // 4. Right shape but terminal state.
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, source_module)
       VALUES ('miss-terminal','p','t','b','mvp','merged','event','arc-chat')`,
    );
    db.close();

    const proc = spawn({
      cmd: ["bun", cli, "--interviewer", "--db", dbPath, "--interval", "1"],
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
    expect(parsed.mode).toBe("interviewer");
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

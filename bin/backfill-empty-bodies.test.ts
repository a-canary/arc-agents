import { test, expect } from "bun:test";
import { $ } from "bun";
import { openWithMigrate } from "../src/ledger/db";
import { unlinkSync, existsSync } from "node:fs";

test("backfills empty bodies from parent_id and nearest PRD, skips unreachable", async () => {
  const dbPath = `/tmp/backfill-test-${Date.now()}.db`;
  const db = openWithMigrate(dbPath);
  const now = Math.floor(Date.now() / 1000);

  db.run(
    "INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, created_at) VALUES ('prd-1','demo','Some PRD','PRD body text','','mvp','merged','prd','mvp','build','agent_unset',?)",
    [now - 100],
  );
  db.run(
    "INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, created_at) VALUES ('task-via-parent','demo','prd-1','Slice A','','','mvp','ready','task','mvp','build','agent_unset',?)",
    [now - 50],
  );
  db.run(
    "INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, created_at) VALUES ('task-via-nearest-prd','demo','Slice B','','','mvp','ready','task','mvp','build','agent_unset',?)",
    [now - 40],
  );
  db.run(
    "INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, created_at) VALUES ('task-unreachable','other-project','Orphan slice','','','mvp','ready','task','mvp','build','agent_unset',?)",
    [now - 10],
  );
  db.close();

  const result = await $`bun ${import.meta.dir}/backfill-empty-bodies.ts ${dbPath}`.json();
  expect(result.repaired).toBe(2);
  expect(result.skipped).toEqual(["task-unreachable"]);

  const check = openWithMigrate(dbPath);
  const a = check.query<{ body_md: string }, [string]>("SELECT body_md FROM issues WHERE id=?").get("task-via-parent");
  expect(a!.body_md).toContain("PRD body text");
  expect(a!.body_md).toContain("prd-1");

  const b = check.query<{ body_md: string }, [string]>("SELECT body_md FROM issues WHERE id=?").get("task-via-nearest-prd");
  expect(b!.body_md).toContain("PRD body text");

  const orphan = check.query<{ body_md: string }, [string]>("SELECT body_md FROM issues WHERE id=?").get("task-unreachable");
  expect(orphan!.body_md).toBe("");

  const events = check.query<{ kind: string; issue_id: string }, []>("SELECT kind, issue_id FROM issue_events WHERE kind='note'").all();
  expect(events.length).toBe(2);
  check.close();

  if (existsSync(dbPath)) unlinkSync(dbPath);
  if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
  if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
});

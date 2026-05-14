import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("migrate is idempotent", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  const second = migrate(db);
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBe(0);
});

test("schema_migrations records applied ids", () => {
  const db = fresh();
  const ids = db.query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => r.id);
  expect(ids).toContain("001_issues_base");
  expect(ids).toContain("005_unblock_trigger");
});

test("007 adds encounter_* columns", () => {
  const db = fresh();
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((r) => r.name);
  expect(cols).toContain("encounter_mode");
  expect(cols).toContain("encounter_timeout_at");
  expect(cols).toContain("encounter_default_resolution");
  // re-running migrate must not error or re-add
  const ran = migrate(db);
  expect(ran.length).toBe(0);
});

test("unblock_dependents cascade fires on merge", () => {
  const db = fresh();
  const ins = (id: string, state: string, blocked_by: string | null) =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, role, state, blocked_by, kind)
       VALUES (?, 'p', 't', 'b', 'task', 'developer', ?, ?, 'task')`,
      [id, state, blocked_by],
    );

  ins("a", "ready", null);
  ins("b", "ready", null);
  ins("c", "blocked", JSON.stringify(["a", "b"]));

  db.run("UPDATE issues SET state='merged' WHERE id='a'");
  let c = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='c'").get();
  expect(c?.state).toBe("blocked");

  db.run("UPDATE issues SET state='merged' WHERE id='b'");
  c = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='c'").get();
  expect(c?.state).toBe("ready");
});

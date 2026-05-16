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
      `INSERT INTO issues (id, project, title, body_md, type, state, blocked_by, kind)
       VALUES (?, 'p', 't', 'b', 'mvp', ?, ?, 'task')`,
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

test("008 drops role column", () => {
  const db = fresh();
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((r) => r.name);
  expect(cols).not.toContain("role");
});

test("008 enforces type enum", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('x','p','t','b','garbage','ready','task')`,
    ),
  ).toThrow();
});

test("008 enforces kind enum", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind)
       VALUES ('x','p','t','b','mvp','ready','--project')`,
    ),
  ).toThrow();
});

test("008 enforces blocked_by shape", () => {
  const db = fresh();
  expect(() =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, blocked_by)
       VALUES ('x','p','t','b','mvp','blocked','task','not-json')`,
    ),
  ).toThrow();
  // NULL still ok
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, blocked_by)
     VALUES ('y','p','t','b','mvp','blocked','task',NULL)`,
  );
});

test("008 normalized trigger fires even when no '[]' filter present", () => {
  const db = fresh();
  const ins = (id: string, state: string, blocked_by: string | null) =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, blocked_by, kind)
       VALUES (?, 'p', 't', 'b', 'mvp', ?, ?, 'task')`,
      [id, state, blocked_by],
    );
  ins("a", "ready", null);
  ins("c", "blocked", JSON.stringify(["a"]));
  db.run("UPDATE issues SET state='merged' WHERE id='a'");
  const c = db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='c'").get();
  expect(c?.state).toBe("ready");
});

test("009 hitl tables exist with check constraints", () => {
  const db = fresh();
  // class=taste requires recommended
  expect(() =>
    db.run(
      `INSERT INTO hitl_prompts (id, kind, class, payload, timeout_sec)
       VALUES ('p1', 'ask_choice', 'taste', '{}', 60)`,
    ),
  ).toThrow();
  // class=impact rejects timeout_sec
  expect(() =>
    db.run(
      `INSERT INTO hitl_prompts (id, kind, class, payload, timeout_sec)
       VALUES ('p2', 'ask_choice', 'impact', '{}', 60)`,
    ),
  ).toThrow();
  db.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, timeout_sec)
     VALUES ('p3', 'ask_choice', 'taste', '{}', 'blue', 60)`,
  );
  const row = db.query<{ state: string }, []>("SELECT state FROM hitl_prompts WHERE id='p3'").get();
  expect(row?.state).toBe("open");
});

test("009 retract cascade flips loser deliveries on answer", () => {
  const db = fresh();
  db.run(
    `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, timeout_sec)
     VALUES ('p1', 'ask_choice', 'taste', '{}', 'blue', 60)`,
  );
  for (const m of ["arc-tui", "arc-webui", "arc-discord"]) {
    db.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state, delivered_at)
       VALUES ('p1', ?, 'delivered', strftime('%s','now'))`,
      [m],
    );
  }
  db.run(
    `UPDATE hitl_prompts SET state='answered', answer='green', answered_by='arc-webui',
            answered_at=strftime('%s','now') WHERE id='p1'`,
  );
  const states = db
    .query<{ module_name: string; state: string }, []>(
      "SELECT module_name, state FROM hitl_deliveries WHERE prompt_id='p1' ORDER BY module_name",
    )
    .all();
  const map = Object.fromEntries(states.map((r) => [r.module_name, r.state]));
  expect(map["arc-webui"]).toBe("delivered"); // winner stays
  expect(map["arc-tui"]).toBe("retracted");
  expect(map["arc-discord"]).toBe("retracted");
});

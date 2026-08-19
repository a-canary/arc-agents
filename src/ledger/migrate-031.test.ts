import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("031_issues_label adds label column", () => {
  const db = fresh();
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(issues)")
    .all()
    .map((r) => r.name);
  expect(cols).toContain("label");
});

test("031_issues_label allows NULL label on insert", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('x','p','t','b','mvp','ready','task')`,
  );
  const row = db.query<{ label: string | null }, []>("SELECT label FROM issues WHERE id='x'").get();
  expect(row?.label).toBeNull();
});

test("031_issues_label allows setting label", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, label)
     VALUES ('y','p','t','b','mvp','ready','task','bug')`,
  );
  const row = db.query<{ label: string | null }, []>("SELECT label FROM issues WHERE id='y'").get();
  expect(row?.label).toBe("bug");
});

test("031_issues_label is idempotent", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("031_issues_label");
  const second = migrate(db);
  expect(second).not.toContain("031_issues_label");
});

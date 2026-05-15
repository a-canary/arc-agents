import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { typeRank, compareByTypeThenId, TYPE_PRIORITY_SQL } from "./type-priority-sort";

test("HITL ranks above everything else", () => {
  expect(typeRank("HITL")).toBeLessThan(typeRank("cron"));
  expect(typeRank("cron")).toBeLessThan(typeRank("mvp"));
  expect(typeRank("mvp")).toBeLessThan(typeRank("deferred"));
});

test("unknown type sinks to bottom", () => {
  expect(typeRank("nonsense")).toBeGreaterThan(typeRank("deferred"));
});

test("comparator sorts a mixed list by priority then id", () => {
  const rows = [
    { id: "z", type: "mvp" },
    { id: "a", type: "deferred" },
    { id: "b", type: "HITL" },
    { id: "c", type: "mvp" },
  ];
  rows.sort(compareByTypeThenId);
  expect(rows.map((r) => r.id)).toEqual(["b", "c", "z", "a"]);
});

test("SQL fragment orders rows correctly in a live query", () => {
  const db = new Database(":memory:");
  migrate(db);
  const ins = (id: string, type: string) =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind) VALUES (?, 'p', 't', 'b', ?, 'ready', 'task')`,
      [id, type],
    );
  ins("z-mvp", "mvp");
  ins("a-deferred", "deferred");
  ins("m-hitl", "HITL");
  ins("c-mvp", "mvp");

  const sorted = db
    .query<{ id: string }, []>(`SELECT id FROM issues ORDER BY ${TYPE_PRIORITY_SQL}, id`)
    .all()
    .map((r) => r.id);
  expect(sorted).toEqual(["m-hitl", "c-mvp", "z-mvp", "a-deferred"]);
});

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { rowRank, compareByTypeThenId, TYPE_PRIORITY_SQL } from "./type-priority-sort";

test("interactive ranks above hitl above nominal above deferred", () => {
  expect(rowRank({ urgency: "interactive" })).toBeLessThan(rowRank({ urgency: "nominal", hitl: 1 }));
  expect(rowRank({ urgency: "nominal", hitl: 1 })).toBeLessThan(rowRank({ urgency: "nominal" }));
  expect(rowRank({ urgency: "nominal" })).toBeLessThan(rowRank({ urgency: "deferred" }));
});

test("unknown urgency sinks to bottom", () => {
  expect(rowRank({ urgency: "nonsense" })).toBeGreaterThan(rowRank({ urgency: "deferred" }));
});

test("comparator sorts a mixed list by priority then id", () => {
  const rows = [
    { id: "z", urgency: "nominal", hitl: 0 },
    { id: "a", urgency: "deferred", hitl: 0 },
    { id: "b", urgency: "nominal", hitl: 1 },
    { id: "c", urgency: "nominal", hitl: 0 },
  ];
  rows.sort(compareByTypeThenId);
  expect(rows.map((r) => r.id)).toEqual(["b", "c", "z", "a"]);
});

test("SQL fragment orders rows correctly in a live query", () => {
  const db = new Database(":memory:");
  migrate(db);
  const ins = (id: string, urgency: string, hitl: number) =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, class, urgency, hitl, state, kind) VALUES (?, 'p', 't', 'b', 'MVP', ?, ?, 'ready', 'task')`,
      [id, urgency, hitl],
    );
  ins("z-nom", "nominal", 0);
  ins("a-def", "deferred", 0);
  ins("m-hitl", "nominal", 1);
  ins("c-nom", "nominal", 0);

  const sorted = db
    .query<{ id: string }, []>(`SELECT id FROM issues ORDER BY ${TYPE_PRIORITY_SQL}, id`)
    .all()
    .map((r) => r.id);
  expect(sorted).toEqual(["m-hitl", "c-nom", "z-nom", "a-def"]);
});

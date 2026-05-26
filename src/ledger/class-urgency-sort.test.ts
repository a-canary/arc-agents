import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import {
  urgencyRank,
  classRank,
  compareBySortKey,
  URGENCY_RANK,
  CLASS_RANK,
  URGENCY_VALUES,
  CLASS_VALUES,
  SORT_KEY_SQL,
  type SortRow,
} from "./class-urgency-sort";

describe("urgencyRank — matrix", () => {
  const cases: Array<[string, number]> = [
    ["interactive", 0],
    ["nominal", 1],
    ["deferred", 2],
    ["nonsense", 999],
  ];
  for (const [u, expected] of cases) {
    test(`urgency=${u} -> ${expected}`, () => {
      expect(urgencyRank(u)).toBe(expected);
    });
  }
});

describe("classRank — matrix", () => {
  const cases: Array<[string, number]> = [
    ["BUG", 0],
    ["MVP", 1],
    ["ops", 2],
    ["hygiene", 3],
    ["quality", 4],
    ["trust", 5],
    ["scale", 6],
    ["efficiency", 7],
    ["class_unset", 99],
    ["nonsense", 999],
  ];
  for (const [c, expected] of cases) {
    test(`class=${c} -> ${expected}`, () => {
      expect(classRank(c)).toBe(expected);
    });
  }
});

test("URGENCY_VALUES and CLASS_VALUES align with RANK maps", () => {
  for (const u of URGENCY_VALUES) expect(URGENCY_RANK[u]).toBeDefined();
  for (const c of CLASS_VALUES) expect(CLASS_RANK[c]).toBeDefined();
});

test("comparator: urgency dominates class", () => {
  // deferred+BUG (worst urgency, best class) sorts AFTER interactive+efficiency
  const rows: SortRow[] = [
    { id: "a", class: "BUG", urgency: "deferred", created_at: 1 },
    { id: "b", class: "efficiency", urgency: "interactive", created_at: 2 },
  ];
  rows.sort(compareBySortKey);
  expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
});

test("comparator: class breaks tie within urgency", () => {
  const rows: SortRow[] = [
    { id: "a", class: "scale", urgency: "nominal", created_at: 1 },
    { id: "b", class: "BUG", urgency: "nominal", created_at: 2 },
    { id: "c", class: "MVP", urgency: "nominal", created_at: 3 },
  ];
  rows.sort(compareBySortKey);
  expect(rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
});

test("comparator: created_at FIFO within (urgency, class)", () => {
  const rows: SortRow[] = [
    { id: "z", class: "MVP", urgency: "nominal", created_at: 300 },
    { id: "y", class: "MVP", urgency: "nominal", created_at: 100 },
    { id: "x", class: "MVP", urgency: "nominal", created_at: 200 },
  ];
  rows.sort(compareBySortKey);
  expect(rows.map((r) => r.id)).toEqual(["y", "x", "z"]);
});

test("comparator: id breaks final tie", () => {
  const rows: SortRow[] = [
    { id: "b", class: "MVP", urgency: "nominal", created_at: 1 },
    { id: "a", class: "MVP", urgency: "nominal", created_at: 1 },
  ];
  rows.sort(compareBySortKey);
  expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
});

test("class_unset sinks to bottom within its urgency band", () => {
  const rows: SortRow[] = [
    { id: "u", class: "class_unset", urgency: "interactive", created_at: 1 },
    { id: "e", class: "efficiency", urgency: "interactive", created_at: 2 },
    { id: "b", class: "BUG", urgency: "nominal", created_at: 3 },
  ];
  rows.sort(compareBySortKey);
  // interactive band first (e, u — efficiency<class_unset), then nominal (b).
  expect(rows.map((r) => r.id)).toEqual(["e", "u", "b"]);
});

test("SQL fragment orders rows correctly in a live query", () => {
  // class/urgency columns exist up through 015; 017 renames them to tier/pool.
  // Test against the 015 schema so class-urgency-sort's SORT_KEY_SQL is valid.
  const { migrateUpTo } = require("./migrate");
  const db = new Database(":memory:");
  migrateUpTo(db, "015_null_claim_on_nonclaim_state");
  const ins = (id: string, klass: string, urgency: string, created_at: number) =>
    db.run(
      `INSERT INTO issues (id, project, title, body_md, type, state, kind, class, urgency, created_at)
       VALUES (?, 'p', 't', 'b', 'mvp', 'ready', 'task', ?, ?, ?)`,
      [id, klass, urgency, created_at],
    );
  // Mixed matrix
  ins("late-interactive-mvp", "MVP", "interactive", 1000);
  ins("early-interactive-bug", "BUG", "interactive", 500);
  ins("nominal-bug", "BUG", "nominal", 100);
  ins("deferred-bug", "BUG", "deferred", 1);
  ins("nominal-mvp-early", "MVP", "nominal", 200);
  ins("nominal-mvp-late", "MVP", "nominal", 300);
  ins("interactive-unset", "class_unset", "interactive", 600);

  const sorted = db
    .query<{ id: string }, []>(`SELECT id FROM issues ORDER BY ${SORT_KEY_SQL}`)
    .all()
    .map((r) => r.id);

  expect(sorted).toEqual([
    "early-interactive-bug",
    "late-interactive-mvp",
    "interactive-unset",
    "nominal-bug",
    "nominal-mvp-early",
    "nominal-mvp-late",
    "deferred-bug",
  ]);
});

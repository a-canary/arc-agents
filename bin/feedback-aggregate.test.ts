import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import { buildAggregateRequest, selectNewFeedback, markAggregated } from "./feedback-aggregate";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "fb-agg-"));
  const db = openWithMigrate(join(dir, "t.db"));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

type DB = ReturnType<typeof openWithMigrate>;
function insert(db: DB, id: string, project: string, state: string, body: string): void {
  db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
    id, project, "public", body, state,
  ]);
}
function row(db: DB, id: string): { state: string; theme_id: string | null } {
  return db
    .query<{ state: string; theme_id: string | null }, [string]>(
      "SELECT state, theme_id FROM feedback WHERE id=?",
    )
    .get(id)!;
}

test("buildAggregateRequest frames every feedback body as a bullet under the project", () => {
  const req = buildAggregateRequest("arc-webui", [
    { id: "fb-1", body_md: "feed pane unstyled on mobile", source: "public" },
    { id: "fb-2", body_md: "kanban columns wrap awkwardly", source: "github" },
  ]);
  expect(req).toContain("arc-webui");
  expect(req).toContain("feed pane unstyled on mobile");
  expect(req).toContain("kanban columns wrap awkwardly");
  expect(req).toContain("2 pieces");
  expect(req).toContain("single coherent change");
});

test("selectNewFeedback returns only 'new' rows for the project, oldest first", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "new", "a");
    insert(db, "fb-b", "arc-webui", "resolved", "b");
    insert(db, "fb-c", "other", "new", "c");
    const rows = selectNewFeedback(db, "arc-webui", 20);
    expect(rows.map((r) => r.id)).toEqual(["fb-a"]);
  } finally {
    cleanup();
  }
});

test("markAggregated links rows to the PRD and resolves them, leaving others", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "new", "a");
    insert(db, "fb-b", "arc-webui", "new", "b");
    insert(db, "fb-keep", "arc-webui", "new", "keep");
    markAggregated(db, ["fb-a", "fb-b"], "prd-x");
    expect(row(db, "fb-a")).toEqual({ state: "resolved", theme_id: "prd-x" });
    expect(row(db, "fb-b")).toEqual({ state: "resolved", theme_id: "prd-x" });
    expect(row(db, "fb-keep")).toEqual({ state: "new", theme_id: null });
  } finally {
    cleanup();
  }
});

test("markAggregated with no ids is a no-op", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "new", "a");
    markAggregated(db, [], "prd-x");
    expect(row(db, "fb-a")).toEqual({ state: "new", theme_id: null });
  } finally {
    cleanup();
  }
});

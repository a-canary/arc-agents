import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import { buildAggregateRequest, selectNewFeedback, markAggregated, isTrusted, confirmsProposal, parseCategoriesJson, summarizeCategories, recordCollection, triggerGate, projectsWithOpenFeedback, type FeedbackRow } from "./feedback-aggregate";

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

test("selectNewFeedback returns only OPEN rows for the project, oldest first", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "OPEN", "a");
    insert(db, "fb-b", "arc-webui", "DEV", "b");
    insert(db, "fb-c", "other", "OPEN", "c");
    const rows = selectNewFeedback(db, "arc-webui", 20);
    expect(rows.map((r) => r.id)).toEqual(["fb-a"]);
  } finally {
    cleanup();
  }
});

test("markAggregated links rows to the PRD and moves them to DEV, leaving others", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "OPEN", "a");
    insert(db, "fb-b", "arc-webui", "OPEN", "b");
    insert(db, "fb-keep", "arc-webui", "OPEN", "keep");
    markAggregated(db, ["fb-a", "fb-b"], "prd-x");
    expect(row(db, "fb-a")).toEqual({ state: "DEV", theme_id: "prd-x" });
    expect(row(db, "fb-b")).toEqual({ state: "DEV", theme_id: "prd-x" });
    expect(row(db, "fb-keep")).toEqual({ state: "OPEN", theme_id: null });
  } finally {
    cleanup();
  }
});

test("markAggregated with no ids is a no-op", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "OPEN", "a");
    markAggregated(db, [], "prd-x");
    expect(row(db, "fb-a")).toEqual({ state: "OPEN", theme_id: null });
  } finally {
    cleanup();
  }
});

test("triggerGate fires on >=1 trusted row regardless of count", () => {
  const rows: FeedbackRow[] = [{ id: "a", source: "direct", submitter: "aaron", body_md: "x" }];
  expect(triggerGate(rows)).toMatchObject({ fire: true, trusted: 1, untrusted: 0 });
});

test("triggerGate fires on >5 untrusted rows, not at 5", () => {
  const five: FeedbackRow[] = Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, source: "public", submitter: `u${i}`, body_md: "x" }));
  expect(triggerGate(five)).toMatchObject({ fire: false, trusted: 0, untrusted: 5 });
  expect(triggerGate([...five, { id: "u5", source: "github", submitter: "u5", body_md: "x" }])).toMatchObject({ fire: true, untrusted: 6 });
});

test("triggerGate does not fire on an empty batch", () => {
  expect(triggerGate([])).toMatchObject({ fire: false, trusted: 0, untrusted: 0 });
});

test("projectsWithOpenFeedback lists distinct projects with OPEN rows only", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "OPEN", "a");
    insert(db, "fb-b", "arc-webui", "OPEN", "b");
    insert(db, "fb-c", "starlight", "OPEN", "c");
    insert(db, "fb-d", "done-proj", "DEV", "d");
    expect(projectsWithOpenFeedback(db).sort()).toEqual(["arc-webui", "starlight"]);
  } finally {
    cleanup();
  }
});

// Confirmation gate (fb-qupj resolved): the Proposal Generator only drafts when a
// theme is corroborated — 1 trusted voice OR 3 distinct untrusted submitters.
test("isTrusted: operator channels trusted, end-user/agent channels not", () => {
  expect(isTrusted("direct")).toBe(true);
  expect(isTrusted("mission")).toBe(true);
  expect(["public", "github", "ai-agent", "anon"].some(isTrusted)).toBe(false);
});

test("confirmsProposal: one trusted voice confirms", () => {
  const g = confirmsProposal([{ id: "a", source: "direct", submitter: "aaron", body_md: "" }]);
  expect(g).toMatchObject({ confirmed: true, trusted: 1, untrusted: 0 });
});

test("confirmsProposal: three distinct untrusted submitters confirm", () => {
  const g = confirmsProposal([
    { id: "a", source: "public", submitter: "u1", body_md: "" },
    { id: "b", source: "github", submitter: "u2", body_md: "" },
    { id: "c", source: "public", submitter: "u3", body_md: "" },
  ]);
  expect(g).toMatchObject({ confirmed: true, trusted: 0, untrusted: 3 });
});

test("confirmsProposal: two untrusted submitters do NOT confirm", () => {
  const g = confirmsProposal([
    { id: "a", source: "public", submitter: "u1", body_md: "" },
    { id: "b", source: "public", submitter: "u2", body_md: "" },
  ]);
  expect(g.confirmed).toBe(false);
});

test("confirmsProposal: one untrusted submitter spamming 3 rows does NOT confirm", () => {
  const g = confirmsProposal([
    { id: "a", source: "public", submitter: "spam", body_md: "" },
    { id: "b", source: "public", submitter: "spam", body_md: "" },
    { id: "c", source: "public", submitter: "spam", body_md: "" },
  ]);
  expect(g).toMatchObject({ confirmed: false, untrusted: 1 });
});

test("confirmsProposal: anonymous untrusted rows (null submitter) count as distinct sources", () => {
  const g = confirmsProposal([
    { id: "a", source: "public", submitter: null, body_md: "" },
    { id: "b", source: "public", submitter: null, body_md: "" },
    { id: "c", source: "public", submitter: null, body_md: "" },
  ]);
  expect(g).toMatchObject({ confirmed: true, untrusted: 3 });
});


// --- Slice 2: the LLM Collector ---
// The Collector extracts thematic categories + counts + patterns from the whole
// batch; the Proposal Generator then gates EACH category (confirmsProposal) rather
// than the batch as one lump. These cover the pure layer; the model call itself
// (collectCategories) degrades to a single 'general' category, like plan-agent.

const ROWS: FeedbackRow[] = [
  { id: "fb-1", source: "public", submitter: "u1", body_md: "feed pane unstyled on mobile" },
  { id: "fb-2", source: "github", submitter: "u2", body_md: "feed text overflows on phones" },
  { id: "fb-3", source: "public", submitter: "u3", body_md: "kanban columns wrap awkwardly" },
];

test("parseCategoriesJson maps the model's categories and keeps only real feedback ids", () => {
  const raw = JSON.stringify({
    categories: [
      { label: "mobile feed", pattern: "feed unreadable on small screens", ids: ["fb-1", "fb-2", "fb-bogus"] },
      { label: "kanban layout", pattern: "columns wrap", ids: ["fb-3"] },
    ],
  });
  const cats = parseCategoriesJson(raw, ROWS);
  expect(cats).not.toBeNull();
  expect(cats!.map((c) => c.label)).toEqual(["mobile feed", "kanban layout"]);
  expect(cats![0]!.ids).toEqual(["fb-1", "fb-2"]); // hallucinated id dropped
});

test("parseCategoriesJson tolerates a prose/fence wrapper and drops categories with no real ids", () => {
  const raw =
    "here you go:\n```json\n" +
    JSON.stringify({
      categories: [
        { label: "real", pattern: "p", ids: ["fb-1"] },
        { label: "ghost", pattern: "p", ids: ["nope"] },
      ],
    }) +
    "\n```";
  const cats = parseCategoriesJson(raw, ROWS);
  expect(cats!.map((c) => c.label)).toEqual(["real"]);
});

test("parseCategoriesJson returns null on unparseable output (caller falls back)", () => {
  expect(parseCategoriesJson("the model rambled with no json", ROWS)).toBeNull();
  expect(parseCategoriesJson("", ROWS)).toBeNull();
});

test("summarizeCategories attaches per-category counts and the confirmation gate", () => {
  const sums = summarizeCategories(ROWS, [
    { label: "mobile feed", pattern: "p", ids: ["fb-1", "fb-2"] }, // 2 distinct untrusted -> not confirmed
    { label: "kanban layout", pattern: "p", ids: ["fb-3"] }, // 1 untrusted -> not confirmed
  ]);
  expect(sums.map((s) => s.count)).toEqual([2, 1]);
  expect(sums.every((s) => s.gate.confirmed === false)).toBe(true);
});

test("summarizeCategories: a category with a trusted voice confirms", () => {
  const rows: FeedbackRow[] = [
    { id: "a", source: "direct", submitter: "aaron", body_md: "x" },
    { id: "b", source: "public", submitter: "u1", body_md: "y" },
  ];
  const sums = summarizeCategories(rows, [{ label: "t", pattern: "p", ids: ["a", "b"] }]);
  expect(sums[0]!.gate).toMatchObject({ confirmed: true, trusted: 1, untrusted: 1 });
  expect(sums[0]!.count).toBe(2);
});

test("summarizeCategories: three distinct untrusted submitters in one category confirm", () => {
  const sums = summarizeCategories(ROWS, [{ label: "mobile", pattern: "p", ids: ["fb-1", "fb-2", "fb-3"] }]);
  expect(sums[0]!.gate).toMatchObject({ confirmed: true, untrusted: 3 });
});


// --- Slice 3a: persist the collector's round to the feedback_theme ledger ---
// CAM: the Collector's per-category output (incl. un-confirmed categories) is the
// audit/evidence the portal surfaces. It lands in the ledger, never a side-channel file.
test("recordCollection persists every category for a round, readable by project", () => {
  const { db, cleanup } = freshDb();
  try {
    recordCollection(db, "arc-webui", "fbr-1", [
      { label: "mobile feed", pattern: "feed unreadable on phones", count: 3, confirmed: true, trusted: 0, untrusted: 3, prdId: "prd-9" },
      { label: "kanban", pattern: "columns wrap", count: 1, confirmed: false, trusted: 0, untrusted: 1, prdId: null },
    ]);
    const rows = db
      .query<{ label: string; count: number; confirmed: number; prd_id: string | null; round_id: string }, [string]>(
        "SELECT label, count, confirmed, prd_id, round_id FROM feedback_theme WHERE project=? ORDER BY id",
      )
      .all("arc-webui");
    expect(rows.map((r) => r.label)).toEqual(["mobile feed", "kanban"]);
    expect(rows[0]).toMatchObject({ count: 3, confirmed: 1, prd_id: "prd-9", round_id: "fbr-1" });
    expect(rows[1]).toMatchObject({ count: 1, confirmed: 0, prd_id: null });
  } finally {
    cleanup();
  }
});

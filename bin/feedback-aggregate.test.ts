import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../src/ledger/db";
import {
  buildAggregateRequest,
  selectNewFeedback,
  triggerGate,
  projectsWithOpenFeedback,
  markAggregated,
  isTrusted,
  confirmsProposal,
  parseCategoriesJson,
  summarizeCategories,
  recordCollection,
  flagStaleFeedback,
  validateStaleCandidates,
  type FeedbackRow,
} from "./feedback-aggregate";

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


// --- Slice 4: 2-pass stale/superseded feedback ---
// Pass 1 (Collector flag): flag feedback rows whose theme_id points to a merged PRD
// created AFTER the feedback, with a tentative verdict. Pass 2 (Validator): verify
// the PRD is still merged, accept (state=resolved, resolution=superseded) or reject
// (state stays new, clear tentative columns).
//
// Schema (migration 024, this slice):
//   feedback.stale_candidate_at     INTEGER  — when pass 1 tentatively flagged it
//   feedback.stale_candidate_prd_id TEXT     — the merged PRD id it links to
//   feedback.resolution             TEXT     — pass-2 verdict (null | 'superseded')

function insertIssue(db: DB, id: string, kind: string, state: string, ts: number): void {
  db.run(
    "INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id, "arc-webui", `prd ${id}`, "", "", "mvp", state, kind, ts, ts],
  );
}

function rowFull(db: DB, id: string): {
  state: string;
  theme_id: string | null;
  stale_candidate_at: number | null;
  stale_candidate_prd_id: string | null;
  resolution: string | null;
} {
  return db
    .query<
      { state: string; theme_id: string | null; stale_candidate_at: number | null; stale_candidate_prd_id: string | null; resolution: string | null },
      [string]
    >("SELECT state, theme_id, stale_candidate_at, stale_candidate_prd_id, resolution FROM feedback WHERE id=?")
    .get(id)!;
}

test("flagStaleFeedback: a new row whose theme_id is a PRD merged AFTER it gets tentatively flagged", () => {
  const { db, cleanup } = freshDb();
  try {
    // feedback created at ts=100, theme_id points to a PRD merged at ts=200
    insertIssue(db, "prd-fresh", "prd", "merged", 200);
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, created_at) VALUES (?,?,?,?,?,?,?)",
      ["fb-a", "arc-webui", "public", "x", "new", "prd-fresh", 100],
    );
    const flagged = flagStaleFeedback(db, "arc-webui");
    expect(flagged).toBe(1);
    const r = rowFull(db, "fb-a");
    expect(r.stale_candidate_at).not.toBeNull();
    expect(r.stale_candidate_prd_id).toBe("prd-fresh");
    expect(r.state).toBe("new"); // pass 1 only flags, doesn't resolve
  } finally {
    cleanup();
  }
});

test("flagStaleFeedback: a row with no merged-PRD link is NEVER flagged", () => {
  const { db, cleanup } = freshDb();
  try {
    // three rows, none with a merged-PRD theme
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", ["fb-1", "arc-webui", "public", "x", "new"]);
    db.run("INSERT INTO feedback (id, project, source, body_md, state, theme_id) VALUES (?,?,?,?,?,?)", ["fb-2", "arc-webui", "public", "y", "new", "prd-gone"]);
    db.run("INSERT INTO feedback (id, project, source, body_md, state, theme_id) VALUES (?,?,?,?,?,?)", ["fb-3", "arc-webui", "public", "z", "new", null]);
    const flagged = flagStaleFeedback(db, "arc-webui");
    expect(flagged).toBe(0);
    expect(rowFull(db, "fb-1").stale_candidate_at).toBeNull();
    expect(rowFull(db, "fb-2").stale_candidate_at).toBeNull(); // prd-gone doesn't exist
    expect(rowFull(db, "fb-3").stale_candidate_at).toBeNull(); // no theme
  } finally {
    cleanup();
  }
});

test("flagStaleFeedback: a row whose theme_id points to a PRD merged BEFORE it is NOT flagged (it triggered the PRD)", () => {
  const { db, cleanup } = freshDb();
  try {
    // feedback at ts=200, theme_id prd merged at ts=100 — feedback came AFTER the merge
    insertIssue(db, "prd-old", "prd", "merged", 100);
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, created_at) VALUES (?,?,?,?,?,?,?)",
      ["fb-late", "arc-webui", "public", "x", "new", "prd-old", 200],
    );
    expect(flagStaleFeedback(db, "arc-webui")).toBe(0);
    expect(rowFull(db, "fb-late").stale_candidate_at).toBeNull();
  } finally {
    cleanup();
  }
});

test("flagStaleFeedback: a row linked to a kind='task' (not PRD) is not flagged even if merged", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, "task-1", "task", "merged", 200);
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, created_at) VALUES (?,?,?,?,?,?,?)",
      ["fb-x", "arc-webui", "public", "x", "new", "task-1", 100],
    );
    expect(flagStaleFeedback(db, "arc-webui")).toBe(0);
  } finally {
    cleanup();
  }
});

test("flagStaleFeedback: a row already resolved is not flagged even if its PRD merged after", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, "prd-r", "prd", "merged", 200);
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, created_at) VALUES (?,?,?,?,?,?,?)",
      ["fb-r", "arc-webui", "public", "x", "resolved", "prd-r", 100],
    );
    expect(flagStaleFeedback(db, "arc-webui")).toBe(0);
  } finally {
    cleanup();
  }
});

test("validateStaleCandidates: accepts a tentative flag -> state=resolved, resolution=superseded", () => {
  const { db, cleanup } = freshDb();
  try {
    insertIssue(db, "prd-v", "prd", "merged", 200);
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, stale_candidate_at, stale_candidate_prd_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["fb-v", "arc-webui", "public", "x", "new", "prd-v", 150, "prd-v", 100],
    );
    const r = validateStaleCandidates(db, "arc-webui");
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(0);
    const row = rowFull(db, "fb-v");
    expect(row.state).toBe("resolved");
    expect(row.resolution).toBe("superseded");
  } finally {
    cleanup();
  }
});

test("validateStaleCandidates: rejects a tentative flag whose PRD was cancelled (no longer merged) -> state stays new", () => {
  const { db, cleanup } = freshDb();
  try {
    // PRD was merged, then we cancel it (state changes); pass 2 must reject
    insertIssue(db, "prd-cx", "prd", "cancelled", 250);
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, stale_candidate_at, stale_candidate_prd_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["fb-cx", "arc-webui", "public", "x", "new", "prd-cx", 150, "prd-cx", 100],
    );
    const r = validateStaleCandidates(db, "arc-webui");
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(1);
    const row = rowFull(db, "fb-cx");
    expect(row.state).toBe("new");
    expect(row.resolution).toBeNull();
    expect(row.stale_candidate_at).toBeNull(); // tentative verdict cleared
    expect(row.stale_candidate_prd_id).toBeNull();
  } finally {
    cleanup();
  }
});

test("validateStaleCandidates: rejects a tentative flag whose PRD no longer exists", () => {
  const { db, cleanup } = freshDb();
  try {
    // no issue row for "prd-missing"
    db.run(
      "INSERT INTO feedback (id, project, source, body_md, state, theme_id, stale_candidate_at, stale_candidate_prd_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ["fb-gone", "arc-webui", "public", "x", "new", "prd-missing", 150, "prd-missing", 100],
    );
    const r = validateStaleCandidates(db, "arc-webui");
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(1);
    expect(rowFull(db, "fb-gone").state).toBe("new");
  } finally {
    cleanup();
  }
});

test("validateStaleCandidates: a row without a tentative flag is left untouched", () => {
  const { db, cleanup } = freshDb();
  try {
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", ["fb-plain", "arc-webui", "public", "x", "new"]);
    const r = validateStaleCandidates(db, "arc-webui");
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(0);
    expect(rowFull(db, "fb-plain").state).toBe("new");
  } finally {
    cleanup();
  }
});

// --- auto-planner additions (PR #286): OPEN-tolerance, trigger gate, --all-projects sweep ---

function insertSrc(db: DB, id: string, project: string, state: string, source: string): void {
  db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
    id, project, source, id, state,
  ]);
}

test("selectNewFeedback also drains 'OPEN' rows (webui normalizes 'new' -> 'OPEN')", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-new", "arc-webui", "new", "n");
    insert(db, "fb-open", "arc-webui", "OPEN", "o");
    insert(db, "fb-done", "arc-webui", "resolved", "d");
    const rows = selectNewFeedback(db, "arc-webui", 20);
    expect(rows.map((r) => r.id).sort()).toEqual(["fb-new", "fb-open"]);
  } finally {
    cleanup();
  }
});

test("triggerGate: one trusted row fires", () => {
  expect(triggerGate([{ id: "1", body_md: "x", source: "operator" }]).fire).toBe(true);
});

test("triggerGate: five untrusted rows do NOT fire (>5 required)", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), body_md: "x", source: "public" }));
  expect(triggerGate(rows).fire).toBe(false);
});

test("triggerGate: six untrusted rows fire", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: String(i), body_md: "x", source: "public" }));
  const g = triggerGate(rows);
  expect(g.fire).toBe(true);
  expect(g.untrusted).toBe(6);
});

test("triggerGate: empty backlog does not fire", () => {
  expect(triggerGate([]).fire).toBe(false);
});

test("projectsWithOpenFeedback: distinct projects with queued rows, excludes resolved-only", () => {
  const { db, cleanup } = freshDb();
  try {
    insertSrc(db, "a1", "alpha", "new", "public");
    insertSrc(db, "a2", "alpha", "OPEN", "public");
    insertSrc(db, "b1", "beta", "OPEN", "public");
    insertSrc(db, "g1", "gamma", "resolved", "public");
    expect(projectsWithOpenFeedback(db)).toEqual(["alpha", "beta"]);
  } finally {
    cleanup();
  }
});

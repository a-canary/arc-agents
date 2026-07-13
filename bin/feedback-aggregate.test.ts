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
  markDeclined,
  isTrusted,
  confirmsProposal,
  parseCategoriesJson,
  summarizeCategories,
  recordCollection,
  flagStaleFeedback,
  validateStaleCandidates,
  MACHINE_LOG_SOURCES,
  type FeedbackRow,
  hasFlag,
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

test("selectNewFeedback skips auto-oversight log rows — display-only, never drained", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "allmissions", "OPEN", "a");
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
      "ao-1", "allmissions", "auto-oversight", "oversight log", "OPEN",
    ]);
    const rows = selectNewFeedback(db, "allmissions", 20);
    expect(rows.map((r) => r.id)).toEqual(["fb-a"]);
  } finally {
    cleanup();
  }
});

// --- Slice: lift the machine-log exclusion into a denylist beside TRUSTED_SOURCES ---
// PR #318 hard-coded `source != 'auto-oversight'` into the two queries. The sibling
// slice (this row) lifts that into MACHINE_LOG_SOURCES so future machine writers
// (watchdog, sync job) are a one-line append rather than a SQL edit, and locks the
// carve-out behind tests that prove the trigger gate can't fire on an oversight-only
// backlog and that the row stays OPEN after a full drain pass.
test("MACHINE_LOG_SOURCES is exported and seeds with auto-oversight", () => {
  expect(MACHINE_LOG_SOURCES).toBeInstanceOf(Set);
  expect(MACHINE_LOG_SOURCES.has("auto-oversight")).toBe(true);
});

test("projectsWithOpenFeedback omits a project whose backlog is ONLY oversight rows", () => {
  const { db, cleanup } = freshDb();
  try {
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
      "ao-1", "allmissions", "auto-oversight", "oversight log 1", "OPEN",
    ]);
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
      "ao-2", "allmissions", "auto-oversight", "oversight log 2", "OPEN",
    ]);
    // sanity: allmissions has 2 oversight rows, nothing else
    expect(projectsWithOpenFeedback(db)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("projectsWithOpenFeedback INCLUDES a project when a human row coexists with oversight rows", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-human", "allmissions", "OPEN", "a real user report");
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
      "ao-1", "allmissions", "auto-oversight", "oversight log", "OPEN",
    ]);
    expect(projectsWithOpenFeedback(db)).toEqual(["allmissions"]);
  } finally {
    cleanup();
  }
});

test("triggerGate: an oversight-only backlog cannot fire (rows never reach triggerGate in production)", () => {
  // Production wiring: aggregateProject calls selectNewFeedback (which filters), then
  // triggerGate. So an oversight-only backlog produces rows=[] and gate.fire=false.
  // Lock that contract by asserting both halves.
  const { db, cleanup } = freshDb();
  try {
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
      "ao-1", "allmissions", "auto-oversight", "log", "OPEN",
    ]);
    const rows = selectNewFeedback(db, "allmissions", 20);
    expect(rows).toEqual([]);
    expect(triggerGate(rows).fire).toBe(false);
  } finally {
    cleanup();
  }
});

test("oversight row's state stays OPEN after a full aggregation pass over the project", () => {
  // The headline test for this slice. Drive the full drain contract — flag stale,
  // validate, select, gate — and assert the oversight row is untouched. (We can't
  // call aggregateProject directly without spawning plan-agent; the four primitives
  // it runs are what matter for the row-stays-OPEN invariant.)
  const { db, cleanup } = freshDb();
  try {
    db.run("INSERT INTO feedback (id, project, source, body_md, state) VALUES (?,?,?,?,?)", [
      "ao-1", "allmissions", "auto-oversight", "log line", "OPEN",
    ]);
    expect(flagStaleFeedback(db, "allmissions")).toBe(0);
    expect(validateStaleCandidates(db, "allmissions")).toEqual({ accepted: 0, rejected: 0 });
    expect(selectNewFeedback(db, "allmissions", 20)).toEqual([]);
    expect(projectsWithOpenFeedback(db)).toEqual([]); // sweep never queues allmissions
    // Row still OPEN, theme_id still null, declined_at still null — no planner
    // was ever called, no write touched the row.
    const r = db.query<{ state: string; theme_id: string | null; declined_at: number | null }, [string]>(
      "SELECT state, theme_id, declined_at FROM feedback WHERE id=?",
    ).get("ao-1")!;
    expect(r.state).toBe("OPEN");
    expect(r.theme_id).toBeNull();
    expect(r.declined_at).toBeNull();
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
  expect(["public", "github", "ai-agent", "anon"].some((s) => isTrusted(s))).toBe(false);
});

test("confirmsProposal: one trusted voice confirms", () => {
  const g = confirmsProposal([{ id: "a", source: "direct", submitter: "aaron", body_md: "" }]);
  expect(g).toMatchObject({ confirmed: true, trusted: 1, untrusted: 0 });
});

// ── author_trust gate: closes the source='direct' degeneracy (slice B3) ───
test("author_trust='product' on a source='direct' row is NOT trusted (closes degeneracy)", () => {
  expect(isTrusted("direct", "product")).toBe(false);
});

test("author_trust='operator' is trusted regardless of channel", () => {
  expect(isTrusted("public", "operator")).toBe(true);
  expect(isTrusted("direct", "operator")).toBe(true);
});

test("null/undefined author_trust falls back to channel logic (legacy back-compat)", () => {
  expect(isTrusted("direct", null)).toBe(true);
  expect(isTrusted("direct", undefined)).toBe(true);
  expect(isTrusted("public", null)).toBe(false);
});

test("confirmsProposal: one product webui row (source='direct') does NOT confirm", () => {
  const g = confirmsProposal([
    { id: "a", source: "direct", submitter: "enduser", author_trust: "product", body_md: "" },
  ]);
  expect(g.confirmed).toBe(false);
  expect(g.trusted).toBe(0);
});

test("confirmsProposal: one operator row confirms", () => {
  const g = confirmsProposal([
    { id: "a", source: "direct", submitter: "aaron", author_trust: "operator", body_md: "" },
  ]);
  expect(g).toMatchObject({ confirmed: true, trusted: 1 });
});

test("confirmsProposal: legacy row (author_trust=null, source='direct') still confirms (back-compat)", () => {
  const g = confirmsProposal([
    { id: "a", source: "direct", submitter: "aaron", author_trust: null, body_md: "" },
  ]);
  expect(g).toMatchObject({ confirmed: true, trusted: 1 });
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

// --- Slice 5: explicit don't-re-propose cooldown marker (migration 027) ---
// The dismiss cascade (PR #18 in arc-webui) sets a `declined_at` timestamp on the
// feedback row IN ADDITION to flipping state. The Collector (selectNewFeedback) must
// skip declined rows regardless of their state column — the marker is the truth.
test("markDeclined sets declined_at AND flips state to resolved", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "new", "a");
    insert(db, "fb-b", "arc-webui", "new", "b");
    const before = Math.floor(Date.now() / 1000);
    markDeclined(db, ["fb-a"]);
    const after = Math.floor(Date.now() / 1000);
    const ra = db.query<{ state: string; declined_at: number | null }, [string]>(
      "SELECT state, declined_at FROM feedback WHERE id=?",
    ).get("fb-a")!;
    const rb = db.query<{ state: string; declined_at: number | null }, [string]>(
      "SELECT state, declined_at FROM feedback WHERE id=?",
    ).get("fb-b")!;
    expect(ra.state).toBe("resolved");
    expect(ra.declined_at).not.toBeNull();
    expect(ra.declined_at!).toBeGreaterThanOrEqual(before);
    expect(ra.declined_at!).toBeLessThanOrEqual(after);
    expect(rb.state).toBe("new");
    expect(rb.declined_at).toBeNull();
  } finally {
    cleanup();
  }
});

test("markDeclined with no ids is a no-op", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "new", "a");
    markDeclined(db, []);
    expect(row(db, "fb-a")).toEqual({ state: "new", theme_id: null });
  } finally {
    cleanup();
  }
});

test("selectNewFeedback excludes rows with non-null declined_at, regardless of state", () => {
  const { db, cleanup } = freshDb();
  try {
    insert(db, "fb-a", "arc-webui", "new", "a");
    insert(db, "fb-b", "arc-webui", "new", "x");
    markDeclined(db, ["fb-b"]);
    // pathological: state='new' BUT declined_at set — marker MUST still exclude it.
    insert(db, "fb-c", "arc-webui", "new", "y");
    db.run("UPDATE feedback SET declined_at=strftime('%s','now') WHERE id=?", ["fb-c"]);
    insert(db, "fb-d", "other", "new", "d");
    const rows = selectNewFeedback(db, "arc-webui", 20);
    expect(rows.map((r) => r.id)).toEqual(["fb-a"]);
  } finally {
    cleanup();
  }
});

test("hasFlag: detects bare --all-projects (getFlag returned undefined — the dry-drain bug)", () => {
  expect(hasFlag(["--all-projects"], "all-projects")).toBe(true);
  expect(hasFlag(["--all-projects=1"], "all-projects")).toBe(true);
  expect(hasFlag([], "all-projects")).toBe(false);
});

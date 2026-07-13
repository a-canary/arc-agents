// Tests for migration 030_event_kind_classifier_and_inplace_review.
// All DBs are throwaway in-memory or tmp-file — never touches ~/vault/ledger.db.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, migrateUpTo } from "./migrate";

function fresh(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// ── Migration id is correct and sorts after 029 ──────────────────────────────

test("030 migration id is '030_event_kind_classifier_and_inplace_review' and sorts after 029", () => {
  const db = fresh();
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((r) => r.id);
  const idx029 = ids.indexOf("029_blog_pr_url");
  const idx030 = ids.indexOf("030_event_kind_classifier_and_inplace_review");
  expect(idx030).toBeGreaterThan(-1);
  expect(idx030).toBeGreaterThan(idx029);
});

// ── CHECK admits the new kinds ───────────────────────────────────────────────

test("030 CHECK admits in_place_review, test-fail, tool-fail, timeout", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('r1','p','r','b','mvp','review','task')`,
  );
  for (const kind of ["in_place_review", "test-fail", "tool-fail", "timeout"] as const) {
    expect(() =>
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, 'test-agent', '{}')`,
        ["r1", kind],
      ),
    ).not.toThrow();
  }
  const rows = db
    .query<{ kind: string }, []>("SELECT kind FROM issue_events WHERE issue_id='r1' ORDER BY kind")
    .all()
    .map((r) => r.kind);
  expect(rows).toContain("in_place_review");
  expect(rows).toContain("test-fail");
  expect(rows).toContain("tool-fail");
  expect(rows).toContain("timeout");
});

// ── CHECK is a superset of the pre-030 vocabulary ───────────────────────────

// 030 rebuilds issue_events, so its CHECK list must carry forward every kind
// admitted by 026_event_kind_operator_landed — a dropped name would silently
// break existing emitters.
test("030 CHECK preserves every kind admitted before it", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('r1','p','r','b','mvp','review','task')`,
  );
  const preExisting = [
    "created", "claimed", "progress", "blocked", "unblocked",
    "evidence", "complete", "failed", "review", "merged",
    "budget-blocked", "mirror-conflict", "note", "reclaimed",
    "diff_review", "triaged", "operator_landed",
  ];
  for (const kind of preExisting) {
    expect(() =>
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, 'test-agent', '{}')`,
        ["r1", kind],
      ),
    ).not.toThrow();
  }
});

// ── CHECK still rejects bogus kinds ──────────────────────────────────────────

test("030 CHECK rejects an unrelated kind name", () => {
  const db = fresh();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('r1','p','r','b','mvp','review','task')`,
  );
  expect(() =>
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'totally-not-a-kind', 'a', NULL)`,
      ["r1"],
    ),
  ).toThrow();
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("030 is idempotent (second migrate() call applies 0 more migrations)", () => {
  const db = new Database(":memory:");
  const first = migrate(db);
  expect(first).toContain("030_event_kind_classifier_and_inplace_review");
  const second = migrate(db);
  expect(second).not.toContain("030_event_kind_classifier_and_inplace_review");
  expect(second.length).toBe(0);
});

// ── Pre-030 rows survive the rebuild ─────────────────────────────────────────

test("030 preserves pre-existing events (table rebuild carries data forward)", () => {
  const db = new Database(":memory:");
  migrateUpTo(db, "028_prd_relationships");
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind)
     VALUES ('r1','p','r','b','mvp','review','task')`,
  );
  // Mix an existing-check kind and one we'll allow after migration.
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES ('r1','claimed','a',NULL)`,
  );
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES ('r1','progress','a','hi')`,
  );
  migrate(db); // applies 030 (rebuilds issue_events_new, copies old data, renames)

  // Pre-existing data survived the rebuild:
  const rows = db
    .query<{ kind: string; payload_md: string | null }, []>(
      "SELECT kind, payload_md FROM issue_events WHERE issue_id='r1' ORDER BY kind",
    )
    .all();
  expect(rows.map((r) => r.kind)).toEqual(["claimed", "progress"]);
  expect(rows.find((r) => r.kind === "progress")?.payload_md).toBe("hi");

  // New kinds now writable:
  expect(() =>
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES ('r1','in_place_review','a','{"reviewer_identity":"x","justification":"y"}')`,
    ),
  ).not.toThrow();
});

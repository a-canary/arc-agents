import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWithMigrate } from "../ledger/db";
import {
  TOP_N,
  ALT_COUNT,
  fingerprint,
  parseDraft,
  runPreDrafter,
  selectTopChatIn,
  templateGenerator,
} from "./pre-drafter";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "pre-drafter-"));
  const db = openWithMigrate(join(dir, "t.db"));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertChatIn(
  db: ReturnType<typeof openWithMigrate>,
  row: {
    id: string;
    title: string;
    body?: string;
    priority?: number | null;
    updated_at?: number;
    state?: string;
    paused?: number;
  },
) {
  const now = row.updated_at ?? Math.floor(Date.now() / 1000);
  db.exec(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, class, urgency, hitl, priority, paused, source_module, created_at, updated_at)
     VALUES (?, 'arc-agents', ?, ?, '', 'interactive', ?, 'event', 'class_unset', 'interactive', 0, ?, ?, 'arc-chat', ?, ?)`,
    [
      row.id,
      row.title,
      row.body ?? row.title,
      row.state ?? "ready",
      row.priority ?? null,
      row.paused ?? 0,
      now,
      now,
    ] as never,
  );
}

test("selectTopChatIn returns chat_in rows ordered by priority then recency", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "first", priority: 10, updated_at: 100 });
    insertChatIn(db, { id: "c2", title: "second", priority: 5, updated_at: 100 });
    insertChatIn(db, { id: "c3", title: "third", priority: 5, updated_at: 200 });
    insertChatIn(db, { id: "c4", title: "fourth", priority: null, updated_at: 300 });
    const rows = selectTopChatIn(db, 3);
    expect(rows.map((r) => r.id)).toEqual(["c3", "c2", "c1"]);
  } finally {
    cleanup();
  }
});

test("selectTopChatIn excludes terminal and paused rows", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "live", priority: 1 });
    insertChatIn(db, { id: "c2", title: "merged", priority: 1, state: "merged" });
    insertChatIn(db, { id: "c3", title: "paused", priority: 1, paused: 1 });
    insertChatIn(db, { id: "c4", title: "cancelled", priority: 1, state: "cancelled" });
    const rows = selectTopChatIn(db);
    expect(rows.map((r) => r.id)).toEqual(["c1"]);
  } finally {
    cleanup();
  }
});

test("templateGenerator produces primary + 2 alternatives", () => {
  const draft = templateGenerator({
    id: "x",
    title: "Should we ship?",
    body_md: "Should we ship the new release tonight?",
    thread_id: null,
    priority: 1,
    updated_at: 0,
    draft_md: null,
  });
  expect(typeof draft.primary).toBe("string");
  expect(draft.primary.length).toBeGreaterThan(0);
  expect(draft.alternatives).toHaveLength(2);
  for (const alt of draft.alternatives) expect(alt.length).toBeGreaterThan(0);
});

test("runPreDrafter populates draft_md for top-N rows only", () => {
  const { db, cleanup } = freshDb();
  try {
    for (let i = 1; i <= 5; i++) {
      insertChatIn(db, { id: `c${i}`, title: `msg ${i}`, priority: i });
    }
    const r = runPreDrafter(db, { now: () => 1000 });
    expect(r.generated.sort()).toEqual(["c1", "c2", "c3"]);
    expect(r.unchanged).toEqual([]);

    const top = selectTopChatIn(db);
    for (const row of top) {
      const d = parseDraft(row.draft_md);
      expect(d).not.toBeNull();
      expect(d!.primary.length).toBeGreaterThan(0);
      expect(d!.alternatives).toHaveLength(ALT_COUNT);
    }

    const beyond = db
      .query<{ draft_md: string | null }, [string]>(
        "SELECT draft_md FROM issues WHERE id = ?",
      )
      .get("c4");
    expect(beyond?.draft_md).toBeNull();
  } finally {
    cleanup();
  }
});

test("runPreDrafter is idempotent — second call reports unchanged", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "hello", priority: 1 });
    const a = runPreDrafter(db, { now: () => 1000 });
    expect(a.generated).toEqual(["c1"]);
    const b = runPreDrafter(db, { now: () => 2000 });
    expect(b.generated).toEqual([]);
    expect(b.unchanged).toEqual(["c1"]);
  } finally {
    cleanup();
  }
});

test("rank change invalidates cache and triggers regeneration", () => {
  const { db, cleanup } = freshDb();
  try {
    // 4 rows. c1 starts as rank-1, then we drop its priority so c2 takes over.
    insertChatIn(db, { id: "c1", title: "alpha", priority: 1, updated_at: 100 });
    insertChatIn(db, { id: "c2", title: "bravo", priority: 2, updated_at: 100 });
    insertChatIn(db, { id: "c3", title: "charlie", priority: 3, updated_at: 100 });
    insertChatIn(db, { id: "c4", title: "delta", priority: 4, updated_at: 100 });

    runPreDrafter(db, { now: () => 1000 });

    // Bump c4 to priority=0. New top-3: c4(0), c1(1), c2(2); c3 falls out.
    db.run("UPDATE issues SET priority = ?, updated_at = ? WHERE id = ?", [0, 200, "c4"] as never);

    const r = runPreDrafter(db, { now: () => 2000 });
    expect(r.generated).toContain("c4");
    expect(r.cleared).toContain("c3");

    const c3 = db
      .query<{ draft_md: string | null }, [string]>(
        "SELECT draft_md FROM issues WHERE id = ?",
      )
      .get("c3");
    expect(c3?.draft_md).toBeNull();
  } finally {
    cleanup();
  }
});

test("body change at same rank invalidates cache", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "hello", body: "original", priority: 1, updated_at: 100 });
    runPreDrafter(db, { now: () => 1000 });
    const before = db
      .query<{ draft_md: string }, [string]>("SELECT draft_md FROM issues WHERE id = ?")
      .get("c1");
    const beforeDraft = parseDraft(before!.draft_md);

    db.run("UPDATE issues SET body_md = ?, updated_at = ? WHERE id = ?", [
      "changed",
      500,
      "c1",
    ] as never);

    const r = runPreDrafter(db, { now: () => 2000 });
    expect(r.generated).toEqual(["c1"]);

    const after = db
      .query<{ draft_md: string }, [string]>("SELECT draft_md FROM issues WHERE id = ?")
      .get("c1");
    const afterDraft = parseDraft(after!.draft_md);
    expect(afterDraft!.source_fp).not.toBe(beforeDraft!.source_fp);
  } finally {
    cleanup();
  }
});

test("custom generator is honored", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "x", priority: 1 });
    runPreDrafter(db, {
      generator: () => ({ primary: "CUSTOM", alternatives: ["A", "B", "C"] }),
      now: () => 1000,
    });
    const row = db
      .query<{ draft_md: string }, [string]>("SELECT draft_md FROM issues WHERE id = ?")
      .get("c1");
    const d = parseDraft(row!.draft_md)!;
    expect(d.primary).toBe("CUSTOM");
    // Sliced to ALT_COUNT.
    expect(d.alternatives).toEqual(["A", "B"]);
  } finally {
    cleanup();
  }
});

test("fingerprint changes when rank or body changes", () => {
  const r1 = {
    id: "x",
    title: "t",
    body_md: "body",
    thread_id: null,
    priority: 1,
    updated_at: 100,
    draft_md: null,
  };
  expect(fingerprint(r1, 1)).not.toBe(fingerprint(r1, 2));
  const r2 = { ...r1, body_md: "different" };
  expect(fingerprint(r1, 1)).not.toBe(fingerprint(r2, 1));
});

test("TOP_N is 3 per slice plan", () => {
  expect(TOP_N).toBe(3);
});

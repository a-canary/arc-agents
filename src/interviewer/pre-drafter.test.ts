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
    // Migration 017: priority column dropped; use updated_at for ordering
    updated_at?: number;
    state?: string;
    paused?: number;
  },
) {
  const now = row.updated_at ?? Math.floor(Date.now() / 1000);
  db.exec(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, hitl, paused, source_module, created_at, updated_at)
     VALUES (?, 'arc-agents', ?, ?, '', 'interactive', ?, 'event', 'tier_unset', 'interactive', 0, ?, 'arc-chat', ?, ?)`,
    [
      row.id,
      row.title,
      row.body ?? row.title,
      row.state ?? "ready",
      row.paused ?? 0,
      now,
      now,
    ] as never,
  );
}

test("selectTopChatIn returns chat_in rows ordered by recency (updated_at DESC)", () => {
  // Migration 017: priority column dropped. Ordering is updated_at DESC.
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "oldest", updated_at: 100 });
    insertChatIn(db, { id: "c2", title: "middle", updated_at: 200 });
    insertChatIn(db, { id: "c3", title: "newest", updated_at: 300 });
    insertChatIn(db, { id: "c4", title: "newest2", updated_at: 400 });
    const rows = selectTopChatIn(db, 3);
    // Top 3 by updated_at DESC: c4, c3, c2
    expect(rows.map((r) => r.id)).toEqual(["c4", "c3", "c2"]);
  } finally {
    cleanup();
  }
});

test("selectTopChatIn excludes terminal and paused rows", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "live" });
    insertChatIn(db, { id: "c2", title: "merged", state: "merged" });
    insertChatIn(db, { id: "c3", title: "paused", paused: 1 });
    insertChatIn(db, { id: "c4", title: "cancelled", state: "cancelled" });
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
    // Migration 017: priority dropped; ordering is updated_at DESC.
    // Insert with ascending updated_at so c5 is newest (rank-1).
    for (let i = 1; i <= 5; i++) {
      insertChatIn(db, { id: `c${i}`, title: `msg ${i}`, updated_at: i * 100 });
    }
    const r = runPreDrafter(db, { now: () => 1000 });
    // Top-3 by updated_at DESC: c5(500), c4(400), c3(300)
    expect(r.generated.sort()).toEqual(["c3", "c4", "c5"]);
    expect(r.unchanged).toEqual([]);

    const top = selectTopChatIn(db);
    for (const row of top) {
      const d = parseDraft(row.draft_md);
      expect(d).not.toBeNull();
      expect(d!.primary.length).toBeGreaterThan(0);
      expect(d!.alternatives).toHaveLength(ALT_COUNT);
    }

    // c1 (updated_at=100) is below the top-3 cutoff; no draft
    const beyond = db
      .query<{ draft_md: string | null }, [string]>(
        "SELECT draft_md FROM issues WHERE id = ?",
      )
      .get("c1");
    expect(beyond?.draft_md).toBeNull();
  } finally {
    cleanup();
  }
});

test("runPreDrafter is idempotent — second call reports unchanged", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "hello" });
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
  // Migration 017: priority dropped; rank is by updated_at DESC.
  // Only 3 rows so none gets evicted from top-3 on 1st run.
  // On 2nd run, c4 (new) bumps in at rank-1; c1 (lowest) falls to rank-4 and is cleared.
  const { db, cleanup } = freshDb();
  try {
    // Use 4 rows. 1st run drafts top-3: c3(300), c2(200), c1(100). c0 (50) is out.
    insertChatIn(db, { id: "c0", title: "zeta", updated_at: 50 });
    insertChatIn(db, { id: "c1", title: "alpha", updated_at: 100 });
    insertChatIn(db, { id: "c2", title: "bravo", updated_at: 200 });
    insertChatIn(db, { id: "c3", title: "charlie", updated_at: 300 });

    runPreDrafter(db, { now: () => 1000 });
    // After 1st run: c3/c2/c1 all have updated_at=1000; c0 still at 50.
    // c0 has no draft_md (was not in top-3).

    // Bump c0 above the rest so it enters top-3 and c1 (lowest among 1000s) falls out.
    // Since c3/c2/c1 all have updated_at=1000 and c0 gets 5000, new top-3 =
    // c0(5000) + 2 of {c3,c2,c1}. The one at rank-4 gets cleared.
    db.run("UPDATE issues SET updated_at = ? WHERE id = ?", [5000, "c0"] as never);

    const r = runPreDrafter(db, { now: () => 2000 });
    // c0 newly entered top-3 (no prior draft) → must be generated
    expect(r.generated).toContain("c0");
    // Exactly one row fell out and its draft was cleared
    expect(r.cleared).toHaveLength(1);

    const fallen = r.cleared[0]!;
    const row = db
      .query<{ draft_md: string | null }, [string]>(
        "SELECT draft_md FROM issues WHERE id = ?",
      )
      .get(fallen);
    expect(row?.draft_md).toBeNull();
  } finally {
    cleanup();
  }
});

test("body change at same rank invalidates cache", () => {
  const { db, cleanup } = freshDb();
  try {
    insertChatIn(db, { id: "c1", title: "hello", body: "original", updated_at: 100 });
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
    insertChatIn(db, { id: "c1", title: "x" });
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

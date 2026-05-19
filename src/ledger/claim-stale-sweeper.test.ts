import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { sweepStaleClaims } from "./claim-stale-sweeper";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function ins(db: Database, id: string, state: string, claimedAt: number | null, claimedBy: string | null = "w1") {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, claimed_at, claimed_by)
     VALUES (?, 'p', 't', 'b', 'mvp', ?, 'task', ?, ?)`,
    [id, state, claimedAt, claimedBy],
  );
}

test("resets a claim older than 2hr", () => {
  const db = setup();
  const now = 1_000_000_000;
  ins(db, "stale", "claimed", now - 7201);
  ins(db, "fresh", "claimed", now - 60);

  const r = sweepStaleClaims(db, { now });
  expect(r.reset).toBe(1);
  expect(r.ids).toEqual(["stale"]);
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='stale'").get()?.state).toBe("ready");
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='fresh'").get()?.state).toBe("claimed");
});

test("custom staleAfterSec respects override", () => {
  const db = setup();
  const now = 1_000_000_000;
  ins(db, "x", "claimed", now - 600);
  const r = sweepStaleClaims(db, { now, staleAfterSec: 300 });
  expect(r.reset).toBe(1);
});

test("nulls out claimed_by and claimed_at", () => {
  const db = setup();
  const now = 1_000_000_000;
  ins(db, "x", "claimed", now - 7201);
  sweepStaleClaims(db, { now });
  const r = db.query<{ claimed_by: string | null; claimed_at: number | null }, []>(
    "SELECT claimed_by, claimed_at FROM issues WHERE id='x'",
  ).get();
  expect(r?.claimed_by).toBeNull();
  expect(r?.claimed_at).toBeNull();
});

test("logs an audit event per reset", () => {
  const db = setup();
  const now = 1_000_000_000;
  ins(db, "x", "claimed", now - 7201);
  sweepStaleClaims(db, { now });
  const events = db.query<{ agent: string; payload_md: string }, []>(
    "SELECT agent, payload_md FROM issue_events WHERE issue_id='x' AND kind='reclaimed'",
  ).all();
  expect(events.length).toBe(1);
  expect(events[0]!.agent).toBe("claim-stale-sweeper");
});

test("reclaimed event records worker id and age", () => {
  const db = setup();
  const now = 1_000_000_000;
  ins(db, "x", "claimed", now - 7201, "arc-worker-zz9");
  sweepStaleClaims(db, { now });
  const rows = db.query<{ payload_md: string }, []>(
    "SELECT payload_md FROM issue_events WHERE issue_id='x' AND kind='reclaimed'",
  ).all();
  expect(rows.length).toBe(1);
  const p = rows[0]!.payload_md;
  expect(p).toContain("arc-worker-zz9");
  expect(p).toMatch(/2\.0hr/);
});

test("no-op when nothing stale", () => {
  const db = setup();
  const now = 1_000_000_000;
  ins(db, "x", "claimed", now - 60);
  ins(db, "y", "ready", null, null);
  const r = sweepStaleClaims(db, { now });
  expect(r.reset).toBe(0);
  expect(r.ids).toEqual([]);
});

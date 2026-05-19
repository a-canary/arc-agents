import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../ledger/migrate";
import { fanout } from "./deliveries";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  // Seed a reply row so target_id refers to something real (no FK on deliveries
  // today, but keeps tests honest).
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, class, urgency, source_module, thread_id)
     VALUES ('reply-1', 'test', 't', '', '', 'mvp', 'ready', 'reply', 'MVP', 'nominal', 'arc-chat', 'thr-1')`,
  );
  return db;
}

function sub(
  db: Database,
  thread_id: string,
  module: string,
  external_ref: string,
  state: "active" | "muted" | "archived" = "active",
) {
  db.run(
    `INSERT INTO thread_subscriptions (thread_id, module, external_ref, state) VALUES (?, ?, ?, ?)`,
    [thread_id, module, external_ref, state],
  );
}

test("fans one pending delivery per active subscription", () => {
  const db = fresh();
  sub(db, "thr-1", "arc-chat", "ch-A");
  sub(db, "thr-1", "arc-webui", "session-B");

  const r = fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  expect(r.inserted).toBe(2);
  expect(r.skipped).toBe(0);

  const rows = db
    .query<{ module: string; external_ref: string; state: string }, []>(
      "SELECT module, external_ref, state FROM deliveries ORDER BY module",
    )
    .all();
  expect(rows).toEqual([
    { module: "arc-chat", external_ref: "ch-A", state: "pending" },
    { module: "arc-webui", external_ref: "session-B", state: "pending" },
  ]);
});

test("muted and archived subscriptions are skipped", () => {
  const db = fresh();
  sub(db, "thr-1", "arc-chat", "ch-A", "active");
  sub(db, "thr-1", "arc-discord", "ch-D", "muted");
  sub(db, "thr-1", "arc-webui", "session-B", "archived");

  const r = fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  expect(r.inserted).toBe(1);
  expect(r.skipped).toBe(2);

  const modules = db
    .query<{ module: string }, []>("SELECT module FROM deliveries")
    .all()
    .map((x) => x.module);
  expect(modules).toEqual(["arc-chat"]);
});

test("double fanout is idempotent — second call inserts nothing", () => {
  const db = fresh();
  sub(db, "thr-1", "arc-chat", "ch-A");
  sub(db, "thr-1", "arc-webui", "session-B");

  const r1 = fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  expect(r1.inserted).toBe(2);

  const r2 = fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  expect(r2.inserted).toBe(0);
  expect(r2.skipped).toBe(2);

  const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM deliveries").get()!.n;
  expect(n).toBe(2);
});

test("adding a new active subscription between fanouts only inserts the new one", () => {
  const db = fresh();
  sub(db, "thr-1", "arc-chat", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  sub(db, "thr-1", "arc-webui", "session-B");
  const r = fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  expect(r.inserted).toBe(1);
  expect(r.skipped).toBe(1);
});

test("different target_id on same thread fans independently", () => {
  const db = fresh();
  sub(db, "thr-1", "arc-chat", "ch-A");
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, class, urgency, source_module, thread_id)
     VALUES ('reply-2', 'test', 't', '', '', 'mvp', 'ready', 'reply', 'MVP', 'nominal', 'arc-chat', 'thr-1')`,
  );

  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  const r = fanout(db, { target_kind: "reply", target_id: "reply-2", thread_id: "thr-1" });
  expect(r.inserted).toBe(1);

  const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM deliveries").get()!.n;
  expect(n).toBe(2);
});

test("hitl_prompt target_kind works the same way", () => {
  const db = fresh();
  sub(db, "thr-1", "arc-chat", "ch-A");
  const r = fanout(db, { target_kind: "hitl_prompt", target_id: "prompt-1", thread_id: "thr-1" });
  expect(r.inserted).toBe(1);
  const row = db
    .query<{ target_kind: string; target_id: string }, []>(
      "SELECT target_kind, target_id FROM deliveries",
    )
    .get()!;
  expect(row.target_kind).toBe("hitl_prompt");
  expect(row.target_id).toBe("prompt-1");
});

test("no subscriptions on thread -> zero inserts, zero skipped", () => {
  const db = fresh();
  const r = fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-empty" });
  expect(r.inserted).toBe(0);
  expect(r.skipped).toBe(0);
});

test("arg validation throws", () => {
  const db = fresh();
  expect(() =>
    fanout(db, { target_kind: "bogus" as "reply", target_id: "x", thread_id: "t" }),
  ).toThrow();
  expect(() =>
    fanout(db, { target_kind: "reply", target_id: "", thread_id: "t" }),
  ).toThrow();
  expect(() =>
    fanout(db, { target_kind: "reply", target_id: "x", thread_id: "" }),
  ).toThrow();
});

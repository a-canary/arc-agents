import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../ledger/migrate";
import { fanout } from "./deliveries";
import { push, type DeliverFn, type PendingDelivery } from "./pusher";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
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

function deliveryStates(db: Database, module: string) {
  return db
    .query<{ state: string; external_ref: string | null; error: string | null }, [string]>(
      `SELECT state, external_ref, error FROM deliveries WHERE module=? ORDER BY id`,
    )
    .all(module);
}

test("pending → delivered when deliver returns delivered", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const deliver: DeliverFn = () => ({ status: "delivered", external_ref: "msg-99" });
  const r = await push(db, "arc-discord", deliver);

  expect(r).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  const rows = deliveryStates(db, "arc-discord");
  expect(rows[0]!.state).toBe("delivered");
  expect(rows[0]!.external_ref).toBe("msg-99");
});

test("delivered preserves original external_ref when deliver returns none", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const deliver: DeliverFn = () => ({ status: "delivered" });
  await push(db, "arc-discord", deliver);

  const rows = deliveryStates(db, "arc-discord");
  expect(rows[0]!.state).toBe("delivered");
  expect(rows[0]!.external_ref).toBe("ch-A");
});

test("pending → failed when deliver throws", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const deliver: DeliverFn = () => {
    throw new Error("boom");
  };
  const r = await push(db, "arc-discord", deliver);

  expect(r).toEqual({ delivered: 0, failed: 1, skipped: 0 });
  const rows = deliveryStates(db, "arc-discord");
  expect(rows[0]!.state).toBe("failed");
  expect(rows[0]!.error).toBe("boom");
});

test("pending → failed when deliver returns failed outcome", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const deliver: DeliverFn = () => ({ status: "failed", error: "rate limited" });
  const r = await push(db, "arc-discord", deliver);

  expect(r.failed).toBe(1);
  expect(deliveryStates(db, "arc-discord")[0]!.error).toBe("rate limited");
});

test("pending → skipped when subscription muted after fanout", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  db.run(
    `UPDATE thread_subscriptions SET state='muted' WHERE module=? AND external_ref=?`,
    ["arc-discord", "ch-A"],
  );

  let called = 0;
  const deliver: DeliverFn = () => {
    called++;
    return { status: "delivered" };
  };
  const r = await push(db, "arc-discord", deliver);

  expect(called).toBe(0);
  expect(r).toEqual({ delivered: 0, failed: 0, skipped: 1 });
  expect(deliveryStates(db, "arc-discord")[0]!.state).toBe("skipped");
});

test("pending → skipped when deliver returns skipped", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const deliver: DeliverFn = () => ({ status: "skipped" });
  const r = await push(db, "arc-discord", deliver);

  expect(r.skipped).toBe(1);
  expect(deliveryStates(db, "arc-discord")[0]!.state).toBe("skipped");
});

test("only drains rows for its own module", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  sub(db, "thr-1", "arc-webui", "session-B");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const seen: PendingDelivery[] = [];
  await push(db, "arc-discord", (r) => {
    seen.push(r);
    return { status: "delivered" };
  });

  expect(seen.length).toBe(1);
  expect(seen[0]!.module).toBe("arc-discord");
  // arc-webui row left pending.
  expect(deliveryStates(db, "arc-webui")[0]!.state).toBe("pending");
});

test("re-running push is a no-op once rows are terminal", async () => {
  const db = fresh();
  sub(db, "thr-1", "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  await push(db, "arc-discord", () => ({ status: "delivered" }));
  const r2 = await push(db, "arc-discord", () => ({ status: "delivered" }));
  expect(r2).toEqual({ delivered: 0, failed: 0, skipped: 0 });
});

test("empty queue returns zeros", async () => {
  const db = fresh();
  const r = await push(db, "arc-discord", () => ({ status: "delivered" }));
  expect(r).toEqual({ delivered: 0, failed: 0, skipped: 0 });
});

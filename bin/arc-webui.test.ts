import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/ledger/migrate";
import { fanout } from "../src/arc-ux/deliveries";
import { push, type DeliverFn } from "../src/arc-ux/pusher";
import { MODULE, deliver, ingestWebhook } from "./arc-webui";

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
  module: string,
  external_ref: string,
  state: "active" | "muted" | "archived" = "active",
) {
  db.run(
    `INSERT INTO thread_subscriptions (thread_id, module, external_ref, state) VALUES (?, ?, ?, ?)`,
    ["thr-1", module, external_ref, state],
  );
}

function rows(db: Database) {
  return db
    .query<{ state: string; external_ref: string | null }, [string]>(
      `SELECT state, external_ref FROM deliveries WHERE module=? ORDER BY id`,
    )
    .all(MODULE);
}

test("module name is 'webui'", () => {
  expect(MODULE).toBe("webui");
});

test("pending → delivered via default deliver stub", async () => {
  const db = fresh();
  sub(db, MODULE, "session-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const r = await push(db, MODULE, deliver);
  expect(r).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  expect(rows(db)[0]!.state).toBe("delivered");
});

test("pending → failed when deliver throws", async () => {
  const db = fresh();
  sub(db, MODULE, "session-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const boom: DeliverFn = () => {
    throw new Error("transport down");
  };
  const r = await push(db, MODULE, boom);
  expect(r).toEqual({ delivered: 0, failed: 1, skipped: 0 });
  expect(rows(db)[0]!.state).toBe("failed");
});

test("pending → skipped when subscription muted after fanout", async () => {
  const db = fresh();
  sub(db, MODULE, "session-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  db.run(
    `UPDATE thread_subscriptions SET state='muted' WHERE module=? AND external_ref=?`,
    [MODULE, "session-A"],
  );

  let called = 0;
  const r = await push(db, MODULE, () => {
    called++;
    return { status: "delivered" };
  });
  expect(called).toBe(0);
  expect(r).toEqual({ delivered: 0, failed: 0, skipped: 1 });
  expect(rows(db)[0]!.state).toBe("skipped");
});

test("only drains rows for module='webui', not 'arc-webui' or 'arc-discord'", async () => {
  const db = fresh();
  sub(db, MODULE, "session-A");
  sub(db, "arc-discord", "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  await push(db, MODULE, deliver);
  // arc-discord row stays pending.
  const other = db
    .query<{ state: string }, [string]>(
      `SELECT state FROM deliveries WHERE module=? ORDER BY id`,
    )
    .all("arc-discord");
  expect(other[0]!.state).toBe("pending");
});

test("ingestWebhook forwards to arc-ux event with module + external-ref", () => {
  const r = ingestWebhook({ sessionId: "sess-42", text: "hi" });
  expect(r.ok).toBe(true);
  expect(r.forwarded).toEqual([
    "event",
    "--module",
    "webui",
    "--external-ref",
    "sess-42",
    "--text",
    "hi",
  ]);
});

test("ingestWebhook omits --text when absent", () => {
  const r = ingestWebhook({ sessionId: "sess-1" });
  expect(r.forwarded).toEqual([
    "event",
    "--module",
    "webui",
    "--external-ref",
    "sess-1",
  ]);
});

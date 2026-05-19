import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../ledger/migrate";
import { lookupOrCreateThread } from "./threads";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("second call with same (module, external_ref) returns same uuid", () => {
  const db = fresh();
  const a = lookupOrCreateThread(db, { module: "arc-discord", external_ref: "ch-1" });
  const b = lookupOrCreateThread(db, { module: "arc-discord", external_ref: "ch-1" });
  expect(a).toBe(b);
});

test("miss mints new uuid and inserts subscription row", () => {
  const db = fresh();
  const tid = lookupOrCreateThread(db, { module: "arc-webui", external_ref: "sess-42" });
  expect(tid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const row = db
    .query<{ thread_id: string; state: string }, [string, string]>(
      "SELECT thread_id, state FROM thread_subscriptions WHERE module=? AND external_ref=?",
    )
    .get("arc-webui", "sess-42");
  expect(row).not.toBeNull();
  expect(row!.thread_id).toBe(tid);
  expect(row!.state).toBe("active");
});

test("different (module, external_ref) pairs mint distinct uuids", () => {
  const db = fresh();
  const t1 = lookupOrCreateThread(db, { module: "arc-discord", external_ref: "ch-1" });
  const t2 = lookupOrCreateThread(db, { module: "arc-discord", external_ref: "ch-2" });
  const t3 = lookupOrCreateThread(db, { module: "arc-webui", external_ref: "ch-1" });
  expect(t1).not.toBe(t2);
  expect(t1).not.toBe(t3);
  expect(t2).not.toBe(t3);
});

test("missing module or external_ref throws", () => {
  const db = fresh();
  expect(() => lookupOrCreateThread(db, { module: "", external_ref: "x" })).toThrow();
  expect(() => lookupOrCreateThread(db, { module: "m", external_ref: "" })).toThrow();
});

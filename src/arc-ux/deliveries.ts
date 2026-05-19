// ADR 0006 — arc-ux deliveries module.
// fanout({target_kind, target_id, thread_id}) -> {inserted, skipped}
// Polymorphic: insert one pending delivery per ACTIVE subscription on the
// thread. muted/archived subscriptions skipped. Idempotent via the
// idx_deliveries_unique index (migration 013): re-running with the same
// (target_kind, target_id, thread_id) is a no-op for already-fanned modules.

import type { Database } from "bun:sqlite";

export type FanoutArgs = {
  target_kind: "reply" | "hitl_prompt";
  target_id: string;
  thread_id: string;
};

export type FanoutResult = {
  inserted: number;
  skipped: number;
};

export function fanout(db: Database, args: FanoutArgs): FanoutResult {
  const { target_kind, target_id, thread_id } = args;
  if (target_kind !== "reply" && target_kind !== "hitl_prompt") {
    throw new Error("fanout: target_kind must be reply|hitl_prompt");
  }
  if (!target_id) throw new Error("fanout: target_id required");
  if (!thread_id) throw new Error("fanout: thread_id required");

  return db.transaction(() => {
    const subs = db
      .query<{ module: string; external_ref: string; state: string }, [string]>(
        "SELECT module, external_ref, state FROM thread_subscriptions WHERE thread_id=?",
      )
      .all(thread_id);

    let inserted = 0;
    let skipped = 0;
    for (const s of subs) {
      if (s.state !== "active") {
        skipped++;
        continue;
      }
      const res = db.run(
        `INSERT OR IGNORE INTO deliveries (target_kind, target_id, module, external_ref, state)
         VALUES (?, ?, ?, ?, 'pending')`,
        [target_kind, target_id, s.module, s.external_ref],
      );
      if (res.changes > 0) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  })();
}

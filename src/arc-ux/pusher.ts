// ADR 0006 — per-module pusher contract.
//
// Each UX module exposes a `push` verb that drains
//   deliveries WHERE state='pending' AND module=<self>
// and transitions each row to one of:
//   delivered  — push succeeded, external_ref filled
//   failed     — push threw; error recorded, attempted_at stamped
//   skipped    — subscription muted/archived since fanout (or deliver returned skip)
//
// State machine (per row):
//   pending ──deliver() ok──> delivered  (external_ref filled if returned)
//   pending ──deliver() skip─> skipped
//   pending ──deliver() throw> failed    (error captured)
//
// Modules supply a `deliver` callback receiving the pending row; the pusher
// owns the SQL transitions so every module behaves identically.
//
// Muted/archived subscriptions are short-circuited to `skipped` without
// calling deliver(), matching fanout's "muted skipped" semantics post-hoc.

import type { Database } from "bun:sqlite";

export type PendingDelivery = {
  id: number;
  target_kind: "reply" | "hitl_prompt";
  target_id: string;
  module: string;
  external_ref: string | null;
};

export type DeliverOutcome =
  | { status: "delivered"; external_ref?: string }
  | { status: "skipped" }
  | { status: "failed"; error: string };

export type DeliverFn = (row: PendingDelivery) => Promise<DeliverOutcome> | DeliverOutcome;

export type PushResult = {
  delivered: number;
  failed: number;
  skipped: number;
};

export async function push(
  db: Database,
  module: string,
  deliver: DeliverFn,
): Promise<PushResult> {
  const pending = db
    .query<PendingDelivery, [string]>(
      `SELECT id, target_kind, target_id, module, external_ref
       FROM deliveries
       WHERE state='pending' AND module=?
       ORDER BY id ASC`,
    )
    .all(module);

  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of pending) {
    // Short-circuit if the subscription went muted/archived after fanout.
    const sub = db
      .query<{ state: string }, [string, string]>(
        `SELECT state FROM thread_subscriptions
         WHERE module=? AND external_ref=?
         LIMIT 1`,
      )
      .get(row.module, row.external_ref ?? "");
    if (sub && sub.state !== "active") {
      db.run(
        `UPDATE deliveries SET state='skipped', attempted_at=strftime('%s','now')
         WHERE id=? AND state='pending'`,
        [row.id],
      );
      skipped++;
      continue;
    }

    let outcome: DeliverOutcome;
    try {
      outcome = await deliver(row);
    } catch (e) {
      outcome = { status: "failed", error: (e as Error).message ?? String(e) };
    }

    if (outcome.status === "delivered") {
      db.run(
        `UPDATE deliveries
         SET state='delivered',
             attempted_at=strftime('%s','now'),
             delivered_at=strftime('%s','now'),
             external_ref=COALESCE(?, external_ref)
         WHERE id=? AND state='pending'`,
        [outcome.external_ref ?? null, row.id],
      );
      delivered++;
    } else if (outcome.status === "skipped") {
      db.run(
        `UPDATE deliveries SET state='skipped', attempted_at=strftime('%s','now')
         WHERE id=? AND state='pending'`,
        [row.id],
      );
      skipped++;
    } else {
      db.run(
        `UPDATE deliveries SET state='failed', attempted_at=strftime('%s','now'), error=?
         WHERE id=? AND state='pending'`,
        [outcome.error, row.id],
      );
      failed++;
    }
  }

  return { delivered, failed, skipped };
}

// ADR 0006 — arc-ux threads module.
// Single entry point: lookupOrCreateThread({module, external_ref}) -> thread_id.
// Idempotent by (module, external_ref). thread_id is a harness-assigned uuid.

import type { Database } from "bun:sqlite";

export type LookupArgs = {
  module: string;
  external_ref: string;
};

function uuid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function lookupOrCreateThread(db: Database, args: LookupArgs): string {
  const { module, external_ref } = args;
  if (!module) throw new Error("lookupOrCreateThread: module required");
  if (!external_ref) throw new Error("lookupOrCreateThread: external_ref required");

  return db.transaction(() => {
    const hit = db
      .query<{ thread_id: string }, [string, string]>(
        "SELECT thread_id FROM thread_subscriptions WHERE module=? AND external_ref=? LIMIT 1",
      )
      .get(module, external_ref);
    if (hit) return hit.thread_id;
    const tid = uuid();
    db.run(
      "INSERT INTO thread_subscriptions (thread_id, module, external_ref) VALUES (?, ?, ?)",
      [tid, module, external_ref],
    );
    return tid;
  })();
}

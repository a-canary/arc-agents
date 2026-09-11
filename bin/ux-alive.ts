#!/usr/bin/env bun
// Which UX modules are alive (ADR 0002)? Prints each module's heartbeat age.
// Exit 0 if at least one is alive, 1 if none — 1 means `hitl emit` will be
// rejected and refusals must open a `type=HITL` ledger row instead.
// ponytail: reads ux_heartbeats directly; the config's `implements` list only
// narrows an already-empty set when nothing is alive.
import { Database } from "bun:sqlite";
import { resolveLedgerDb } from "../src/ledger/ux-config";

const STALE_SEC = 300;
const db = new Database(resolveLedgerDb(), { readonly: true });
const rows = db
  .query<{ module_name: string; age: number }, []>(
    "SELECT module_name, strftime('%s','now') - last_beat AS age FROM ux_heartbeats ORDER BY last_beat DESC",
  )
  .all();

for (const r of rows) {
  console.log(`${r.module_name.padEnd(16)} ${r.age}s ago${r.age < STALE_SEC ? "  ALIVE" : ""}`);
}
if (rows.length === 0) console.log("(no ux_heartbeats rows)");
process.exit(rows.some((r) => r.age < STALE_SEC) ? 0 : 1);

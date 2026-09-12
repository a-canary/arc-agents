#!/usr/bin/env bun
// Which UX modules are alive (ADR 0002)? Prints each module's heartbeat age.
// Exit 0 if at least one is alive, 1 if none — 1 means `hitl emit` will be
// rejected and refusals must open a `type=HITL` ledger row instead.
// ponytail: reads ux_heartbeats directly; the config's `implements` list only
// narrows an already-empty set when nothing is alive.
import { Database } from "bun:sqlite";
import { resolveLedgerDb } from "../src/ledger/ux-config";

const STALE_SEC = 300;

export type Beat = { module_name: string; age: number };

export function heartbeats(db: Database): Beat[] {
  return db
    .query<Beat, []>(
      "SELECT module_name, strftime('%s','now') - last_beat AS age FROM ux_heartbeats ORDER BY last_beat DESC",
    )
    .all();
}

/** Lines printed, then the exit code (0 = some module alive). */
export function report(rows: Beat[]): { lines: string[]; exitCode: number } {
  const lines = rows.map(
    (r) => `${r.module_name.padEnd(16)} ${r.age}s ago${r.age < STALE_SEC ? "  ALIVE" : ""}`,
  );
  if (rows.length === 0) lines.push("(no ux_heartbeats rows)");
  return { lines, exitCode: rows.some((r) => r.age < STALE_SEC) ? 0 : 1 };
}

if (import.meta.main) {
  const { lines, exitCode } = report(heartbeats(new Database(resolveLedgerDb(), { readonly: true })));
  for (const l of lines) console.log(l);
  process.exit(exitCode);
}

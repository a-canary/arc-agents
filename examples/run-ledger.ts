#!/usr/bin/env bun
// Ledger CLI demo — runnable from a clean clone.
// Demonstrates the full arc-agents core loop in TypeScript.
// Uses /tmp/arc-demo.sqlite by default; override with ARC_LEDGER_DB env var.
//
// Requires: bun (bun.sh)
//
// This file is the canonical "script or examples/ dir" deliverable for
// the [anti-sycophancy-benchmark] Public examples runnable task.
//
// No private paths, no proprietary keys.  GITHUB_TOKEN is optional
// (only used by the deploy-preview probe, not by this demo).

import { Database } from "bun:sqlite";
import { open, openWithMigrate, mintId } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { claimOnce } from "../src/ledger/claim";
import { validateCreate, validateStateTransition, type CreateInput } from "../src/ledger/bookie-validator";

// ---------------------------------------------------------------------------
// Config — public / self-contained
// ---------------------------------------------------------------------------
const LEDGER_DB = process.env.ARC_LEDGER_DB ?? "/tmp/arc-demo.sqlite";
const WORKER = `demo-worker-${process.pid}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function announce(label: string): void {
  console.error(`\n=== ${label} ===\n`);
}

function cmd(label: string, fn: () => void): void {
  console.error(`$ ${label}`);
  fn();
}

function json(label: string, data: unknown): void {
  console.error(`$ ${label}`);
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.error("arc-agents ledger demo");
console.error(`Ledger DB: ${LEDGER_DB}`);
console.error("");

announce("1. Init ledger (creates tables + runs migrations)");
cmd("bun bin/ledger.ts init --db $LEDGER_DB", () => {
  const db = open(LEDGER_DB);
  const ran = migrate(db);
  json("migrations applied", { applied: ran });
});

announce("2. Create a demo task");
const TASK_TITLE = "Demo: public arc-agents ledger example";
const input: CreateInput = {
  title: TASK_TITLE,
  kind: "task",
  type: "quality",
  body: "Runnable demo showing arc-agents ledger usage from TypeScript.",
  acceptance: "Init, create, list, claim, update, event, tick all succeed.",
  project: "arc-agents",
};
const errs = validateCreate(input, []);
if (errs.length > 0) {
  console.error("create validation errors:", errs);
  process.exit(1);
}
const db = openWithMigrate(LEDGER_DB);
const id = mintId(db, TASK_TITLE);
db.run(
  `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, thread_id, source_module, tier, pool, agent)
   VALUES (?, ?, NULL, ?, ?, ?, ?, 'ready', 'task', NULL, NULL, NULL, 'tier_unset', 'pool_unset', 'developer')`,
  [id, "arc-agents", TASK_TITLE, input.body!, input.acceptance!, input.type!],
);
db.run(
  `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', 'cli', ?)`,
  [id, TASK_TITLE],
);
console.log(`Created task: ${id}`);

announce("3. List open tasks");
cmd("ledger list", () => {
  const rows = db
    .query<{ id: string; state: string; kind: string; type: string; title: string }, []>(
      `SELECT id, state, kind, type, title FROM issues WHERE state NOT IN ('merged','cancelled','failed') LIMIT 20`,
    )
    .all();
  json("open tasks", rows);
});

announce("4. Claim the task");
const claimed = claimOnce(db, WORKER);
json("claim result", { claimed });

announce("5. Advance to wip + add progress event");
const state1 = "wip";
const cur = db.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get(id)!;
const errs2 = validateStateTransition(cur.state as never, state1 as never);
if (errs2.length === 0) {
  db.run(`UPDATE issues SET state=?, updated_at=strftime('%s','now') WHERE id=?`, [state1, id]);
  db.run(
    `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'progress', 'cli', ?)`,
    [id, `→ ${state1}`],
  );
  console.log(`Updated: ${id} → ${state1}`);
}

announce("6. Tick (cascade-unblock + reclaim stale)");
const { sweepStaleClaims } = await import("../src/ledger/claim-stale-sweeper");
const s = sweepStaleClaims(db);
json("tick result", { unblocked: 0, reclaimed: s.reset, reclaimed_ids: s.ids });

announce("7. Show full issue + events");
const issue = db.query("SELECT * FROM issues WHERE id=?").get(id);
const events = db
  .query<{ seq: number; ts: number; agent: string; kind: string; payload_md: string }, [string]>(
    "SELECT seq, ts, agent, kind, payload_md FROM issue_events WHERE issue_id=? ORDER BY seq",
  )
  .all(id);
json("issue + events", { issue, events });

announce("Done");
console.error(`Ledger DB at: ${LEDGER_DB}`);
console.error("To inspect:  sqlite3", LEDGER_DB, "'.tables'");
console.error("To reset:    rm", LEDGER_DB);
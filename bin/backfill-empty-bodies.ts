#!/usr/bin/env bun
// One-shot backfill for empty-body ready task rows. Reconstructs body_md from
// the originating parent PRD (via parent_id, or nearest-preceding same-project
// PRD when parent_id is absent) and emits a `note` event on each repaired row.
// Leaves hitl and project untouched; skips rows with no usable source body.
import { openWithMigrate } from "../src/ledger/db";

const db = openWithMigrate(process.argv[2]);

const targets = db
  .query<{ id: string; title: string; project: string; parent_id: string | null; created_at: number }, []>(
    "SELECT id, title, project, parent_id, created_at FROM issues WHERE kind='task' AND state='ready' AND length(coalesce(body_md,''))=0",
  )
  .all();

function sourceBody(row: { project: string; parent_id: string | null; created_at: number }): { id: string; title: string; body: string } | null {
  if (row.parent_id) {
    const parent = db
      .query<{ id: string; title: string; body_md: string | null }, [string]>("SELECT id, title, body_md FROM issues WHERE id=?")
      .get(row.parent_id);
    if (parent?.body_md) return { id: parent.id, title: parent.title, body: parent.body_md };
    return null;
  }
  const prd = db
    .query<{ id: string; title: string; body_md: string | null }, [string, number]>(
      "SELECT id, title, body_md FROM issues WHERE kind='prd' AND project=? AND created_at<=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(row.project, row.created_at);
  if (prd?.body_md) return { id: prd.id, title: prd.title, body: prd.body_md };
  return null;
}

const agent = "backfill-empty-bodies";
let repaired = 0;
const skipped: string[] = [];

db.exec("BEGIN");
try {
  for (const row of targets) {
    const src = sourceBody(row);
    if (!src) {
      skipped.push(row.id);
      continue;
    }
    const body = `Reconstructed from source ${src.id} ("${src.title}"). This task is one slice of that PRD/parent; see below for full source context.\n\n---\n\n${src.body}`;
    db.run("UPDATE issues SET body_md=?, updated_at=strftime('%s','now') WHERE id=?", [body, row.id]);
    db.run(
      "INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', ?, ?)",
      [row.id, agent, `body_md backfilled from ${src.id} (one-shot-backfill-for-the-32-existing-em)`],
    );
    repaired++;
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

console.log(JSON.stringify({ total: targets.length, repaired, skipped }, null, 2));

#!/usr/bin/env bun
// One-shot backfill: convert pre-fix `state=failed` no-work rows to `blocked`
// with the `engine-alias-no-work:<alias>` marker so the recovery sweep can
// govern them via the same path as post-fix rows.
//
// Pre-fix signature (worker-shell before d1f9ae3):
//   "headless reconcile: all N candidate engine(s) for alias '<alias>' produced no work (last rc=X); marked failed."
// Post-fix signature (d1f9ae3+) appends the marker and lands in `blocked` directly.
//
// This script only touches rows that are STILL in `failed` with the pre-fix
// signature; rows already in `blocked` (post-fix or already-converted) are
// skipped — idempotent.
//
// It does NOT flip rows to `ready`. Recovery is the sweep's job on its normal
// cadence (single governed path, prevents blind requeue when alias is still
// starved).
import { openWithMigrate } from "../src/ledger/db";

const db = openWithMigrate(process.argv[2]);

// Pre-fix signature: prefix + suffix "; marked failed." (worker-shell pre-d1f9ae3).
// Extract the alias out of the prefix; reject anything that doesn't match.
const PRE_FIX_RE = /^headless reconcile: all \d+ candidate engine\(s\) for alias '([^']+)' produced no work \(last rc=\d+\); marked failed\.$/;

interface Target { id: string; evidence_md: string }

const targets = db
  .query<Target, []>(
    "SELECT id, evidence_md FROM issues WHERE state='failed' AND evidence_md LIKE 'headless reconcile: %produced no work%'",
  )
  .all();

const agent = "backfill-failed-to-blocked";
let converted = 0;
let skipped = 0;
const byAlias = new Map<string, number>();

db.exec("BEGIN");
try {
  for (const row of targets) {
    const m = PRE_FIX_RE.exec(row.evidence_md.trim());
    const alias = m?.[1];
    if (!alias) {
      skipped++;
      continue;
    }
    // Strip "; marked failed." (pre-fix terminal suffix) and append the
    // post-fix marker so the evidence looks like a post-fix no-work row.
    const baseEvidence = row.evidence_md.replace(/; marked failed\.$/, "");
    const newEvidence = `${baseEvidence}; engine-alias-no-work:${alias}`;
    db.run(
      "UPDATE issues SET state='blocked', evidence_md=?, updated_at=strftime('%s','now') WHERE id=?",
      [newEvidence, row.id],
    );
    db.run(
      "INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', ?, ?)",
      [row.id, agent, `failed→blocked by backfill (one-shot-backfill-cli-convert-pre-fix-st); alias='${alias}'`],
    );
    converted++;
    byAlias.set(alias, (byAlias.get(alias) ?? 0) + 1);
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

const breakdown = Object.fromEntries([...byAlias.entries()].sort(([a], [b]) => a.localeCompare(b)));
console.log(
  JSON.stringify(
    {
      total: targets.length,
      converted,
      skipped,
      byAlias: breakdown,
    },
    null,
    2,
  ),
);
#!/usr/bin/env bun
/**
 * bin/migrate-029.ts — STUB
 *
 * Wave 4 of the ADR-0013 (terms-migration) plan:
 *   issue  → ticket   (table + JSON key + CLI verb)
 *   prd    → spec     (kind enum value)
 *
 * Shipped with Wave 3's deprecation aliases still active. After the
 * deprecation window (1 release), this migration script runs ONCE in prod
 * to remove the legacy columns/views. Until then, dual-write + dual-read
 * keeps both names working so workers and the webui stay green.
 *
 * STUB STATUS (2026-07-30): skeleton only. The real migration must:
 *   1. Cover tests (gate: migration.test.ts must pass before merge)
 *   2. Be reversible (capture schema snapshot before any DDL)
 *   3. Run inside a single SQLite transaction
 *   4. Coordinate with the dual-write layer (bin/ledger.ts writes through it)
 *
 * Full ADR: ~/repos/arc-agents/docs/adr/0013-issue-ticket-prd-spec-rename.md
 */

import { Database } from "bun:sqlite";

const SCHEMA_BEFORE = `
-- Snapshot the legacy columns before any rename. Rollback re-creates them.
ATTACH DATABASE ':memory:' AS legacy_snapshot;
CREATE TABLE legacy_snapshot.issues AS SELECT * FROM main.issues;
CREATE TABLE legacy_snapshot.issue_events AS SELECT * FROM main.issue_events;
DETACH DATABASE legacy_snapshot;
`;

const RENAMES = [
  // Step 1: rename tables (SQLite ALTER TABLE RENAME is fast and safe).
  `ALTER TABLE issues RENAME TO tickets;`,
  `ALTER TABLE issue_events RENAME TO ticket_events;`,

  // Step 2: kind enum value migration. kind='prd' → kind='spec'.
  // Note: a discriminator (kind=spec, type=prd) is introduced in a sibling
  // migration (migrate-030.ts) — that one backfills type='prd' for any
  // kind='spec' row missing a type. Wave 4 only renames the kind value.
  `UPDATE rows SET kind='spec' WHERE kind='prd';`,
];

const POST_DUAL_WRITE_WINDOW = [
  // Step 3: drop the legacy synonym views / tables created by Wave 3's
  // dual-write shim. Run ONLY after the deprecation window has expired.
  // (Stub: list the drops the real migration will execute.)
  // `DROP VIEW IF EXISTS issues;`,         // legacy alias view
  // `DROP VIEW IF EXISTS issue_events;`,   // legacy alias view
];

export function migrate029(db: Database): { ok: boolean; notes: string[] } {
  const notes: string[] = [];

  // Pre-flight: ensure the legacy tables exist (idempotent re-runs).
  const hasIssues = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='issues'")
    .get();
  if (!hasIssues) {
    notes.push("skip: 'issues' table not present — already migrated or fresh DB");
    return { ok: true, notes };
  }

  // Step 0: snapshot. (Stub uses :memory:; real migration writes to
  // ~/vault/ledger.migrate-029.bak for rollback safety.)
  db.exec(SCHEMA_BEFORE);

  // Step 1+2: renames, in a single transaction.
  db.transaction(() => {
    for (const stmt of RENAMES) db.exec(stmt);
  })();
  notes.push(`renamed: ${RENAMES.length} statements applied`);

  // Step 3 deferred to deprecation-window cleanup.
  notes.push(`deferred: ${POST_DUAL_WRITE_WINDOW.length} drops (post-deprecation)`);

  return { ok: true, notes };
}

// CLI entry — invoke as `bun bin/migrate-029.ts`.
if (import.meta.main) {
  const dbPath = process.env.LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`;
  const db = new Database(dbPath, { readonly: false });
  const result = migrate029(db);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

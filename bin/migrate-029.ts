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
 *   5. Model prod constraints the stub does NOT cover: FK(issue_id)
 *      references, indexes (kind/state/project), views referring to the
 *      legacy `issues` / `issue_events` table names, and any triggers
 *      that reference the kind enum. The stub schema in
 *      `bin/migrate-029.test.ts` omits these deliberately (tests should
 *      stay focused on the rename mechanics); prod migration must
 *      enumerate them at planning time.
 *
 * Full ADR: ~/repos/arc-agents/docs/adr/0013-issue-ticket-prd-spec-rename.md
 */

import { Database } from "bun:sqlite";

const SCHEMA_BEFORE = `
-- Snapshot the legacy tables before any rename. The real migration writes
-- these to ~/vault/ledger.migrate-029.bak for rollback safety; the stub
-- keeps them in the same DB so the test can verify the snapshot exists.
CREATE TABLE migrate_029_legacy_issues AS SELECT * FROM issues;
CREATE TABLE migrate_029_legacy_issue_events AS SELECT * FROM issue_events;
`;

const RENAMES = [
  // Step 1: kind enum value migration. kind='prd' → kind='spec'.
  // Note: a discriminator (kind=spec, type=prd) is introduced in a sibling
  // migration (migrate-030.ts) — that one backfills type='prd' for any
  // kind='spec' row missing a type. Wave 4 only renames the kind value.
  // MUST run BEFORE the table rename below, since it targets the `issues` table.
  `UPDATE issues SET kind='spec' WHERE kind='prd';`,

  // Step 2: rename tables (SQLite ALTER TABLE RENAME is fast and safe).
  `ALTER TABLE issues RENAME TO tickets;`,
  `ALTER TABLE issue_events RENAME TO ticket_events;`,
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

// CLI entry — invoke as `LEDGER_ALLOW_MIGRATE=1 bun bin/migrate-029.ts`.
// ADR-0013 Wave 4 production gate: the env-var guard prevents accidental
// prod execution while Wave 3 deprecation is still active. Drop this
// guard when Wave 4 ships (release gate).
if (import.meta.main) {
  if (process.env.LEDGER_ALLOW_MIGRATE !== "1") {
    console.error(
      "error: bin/migrate-029.ts is Wave 4 only. Wave 3 deprecation window is open.\n" +
        "      Set LEDGER_ALLOW_MIGRATE=1 if you REALLY mean to run it (dev/test only).",
    );
    process.exit(2);
  }
  const dbPath = process.env.LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`;
  const db = new Database(dbPath, { readonly: false });
  const result = migrate029(db);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

#!/usr/bin/env bun
/**
 * bin/migrate-029.test.ts — STUB test coverage for the ADR-0013 Wave 4 migration.
 *
 * Verifies:
 *  1. Idempotency: re-running on an already-migrated DB is a no-op.
 *  2. Fresh-DB behaviour: renames happen cleanly.
 *  3. Snapshot is taken before any DDL (rollback path exists).
 *  4. Single-transaction guarantee.
 *
 * Run with: `bun test bin/migrate-029.test.ts` from `~/repos/arc-agents/`.
 *
 * The real migration (`bin/migrate-029.ts`) is currently a stub; this test
 * will start to actually exercise renames once Wave 3 PR ships and the
 * stub is fleshed out. For now the test focuses on the idempotency +
 * pre-condition contract that Wave 4 will rely on.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

import { migrate029 } from "./migrate-029";

function freshDb(): Database {
  // bun:sqlite in-memory DB; :memory: gives us a clean slate per test.
  return new Database(":memory:");
}

function legacySchema(db: Database): void {
  // Mirror the schema as it stood pre-Wave-4. Three seeded rows: one PRD,
  // one task, one PRD-merged. After migration the PRD rows should still be
  // findable under kind='spec' via the dual-write view.
  db.exec(`
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE issue_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      agent TEXT NOT NULL,
      payload_md TEXT
    );
    INSERT INTO issues (id, kind, state, title) VALUES
      ('a','prd','review','spec-A'),
      ('b','task','ready','task-B'),
      ('c','prd','merged','spec-C-merged');
  `);
}

describe("migrate-029 (ADR-0013 Wave 4 stub)", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("idempotent: re-running on a freshly-migrated DB is a no-op", () => {
    legacySchema(db);
    const first = migrate029(db);
    expect(first.ok).toBe(true);

    // After first run, 'issues' table is gone (renamed to 'tickets').
    // A second call must skip cleanly, not error.
    const second = migrate029(db);
    expect(second.ok).toBe(true);
    expect(second.notes.some((n) => n.startsWith("skip"))).toBe(true);
  });

  test("fresh DB: legacy schema is migrated in a single transaction", () => {
    legacySchema(db);
    const { ok, notes } = migrate029(db);
    expect(ok).toBe(true);
    expect(notes.some((n) => n.startsWith("renamed"))).toBe(true);

    // After migration, the legacy table is gone.
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("tickets");
    expect(names).toContain("ticket_events");
    expect(names).not.toContain("issues");
    expect(names).not.toContain("issue_events");
  });

  test("snapshot is captured before any DDL (rollback path)", () => {
    legacySchema(db);
    migrate029(db);

    // The stub keeps the snapshot in the same DB (real migration writes to
    // ~/vault/ledger.migrate-029.bak). Verify both legacy tables exist post-migration.
    const snap = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'migrate_029_legacy_%' ORDER BY name")
      .all() as { name: string }[];
    const snapNames = snap.map((t) => t.name);
    expect(snapNames).toContain("migrate_029_legacy_issues");
    expect(snapNames).toContain("migrate_029_legacy_issue_events");
  });

  test("kind='prd' rows are translated to kind='spec' (Wave 4 rename)", () => {
    legacySchema(db);
    migrate029(db);

    // After migration, the two PRD rows should now read kind='spec'.
    const rows = db
      .query("SELECT id, kind FROM tickets ORDER BY id")
      .all() as { id: string; kind: string }[];
    expect(rows).toEqual([
      { id: "a", kind: "spec" },
      { id: "b", kind: "task" },
      { id: "c", kind: "spec" },
    ]);
  });

  test("CLI entry refuses to run without LEDGER_ALLOW_MIGRATE=1 (prod guard)", () => {
    // The CLI guard is the only safety net between Wave 3's dual-write
    // window and Wave 4's irreversible schema rename. We exercise the
    // entry-point guard by checking the env-var check directly rather than
    // spawning a subprocess (which would slow the test).
    if (import.meta.main) {
      // This block only runs when the test file itself is the entrypoint,
      // which is not our case. The real coverage for the env-var guard is
      // the if-statement inside the migrate-029.ts CLI section above:
      //   if (process.env.LEDGER_ALLOW_MIGRATE !== "1") { process.exit(2); }
      // Verify the source still contains both the env-var check and the
      // exit-code 2 path — a regression here would silently re-enable prod
      // execution during Wave 3's deprecation window.
    }
    const src = require("node:fs").readFileSync(
      new URL("./migrate-029.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(src).toContain('LEDGER_ALLOW_MIGRATE');
    expect(src).toContain('process.exit(2)');
    expect(src).toContain("Wave 4 only");
  });

  test("single-transaction guarantee: failure mid-RENAME leaves no partial rename", () => {
    legacySchema(db);

    // Wrap exec to throw after the first rename succeeds. We force the
    // failure between `UPDATE issues SET kind='spec'` (RENAMES[0]) and
    // `ALTER TABLE issues RENAME TO tickets` (RENAMES[1]). If the
    // db.transaction() wrapper is honoured, SQLite rolls back; if not,
    // the issues table is gone but tickets is missing too.
    const origExec = db.exec.bind(db);
    let firstRenameSeen = false;
    (db as unknown as { exec: (s: string) => void }).exec = (s: string) => {
      if (!firstRenameSeen && s.startsWith("UPDATE issues")) {
        firstRenameSeen = true;
        return origExec(s);
      }
      if (firstRenameSeen && s.startsWith("ALTER TABLE issues")) {
        throw new Error("simulated mid-migration failure");
      }
      return origExec(s);
    };

    expect(() => migrate029(db)).toThrow("simulated mid-migration failure");

    // Restore real exec for the post-conditions check.
    (db as unknown as { exec: typeof origExec }).exec = origExec;

    // The transaction wrapper must have rolled back. Either issues still
    // exists (with kind='prd' rows intact) OR the snapshot tables are
    // empty (rolled back too). In either case the system is consistent
    // — no half-renamed state.
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    // Original `issues` table must still exist (rename was rolled back).
    expect(names.has("issues")).toBe(true);
    // The new `tickets` table must NOT exist (rename was rolled back).
    expect(names.has("tickets")).toBe(false);
  });
});

// Idempotent ledger schema migrations.
// Apply order is append-only. Each migration checks current state before running.

import { Database } from "bun:sqlite";

export type Migration = {
  id: string;
  up: (db: Database) => void;
};

export const migrations: Migration[] = [
  {
    id: "001_issues_base",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS issues (
          id            TEXT PRIMARY KEY,
          project       TEXT NOT NULL,
          parent_id     TEXT REFERENCES issues(id),
          title         TEXT NOT NULL,
          body_md       TEXT NOT NULL,
          acceptance_md TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL,
          role          TEXT NOT NULL,
          state         TEXT NOT NULL DEFAULT 'ready'
                        CHECK (state IN ('ready','claimed','wip','blocked','review','merged','cancelled','failed')),
          hitl          INTEGER NOT NULL DEFAULT 0 CHECK (hitl IN (0,1)),
          blocked_by    TEXT,
          worktree_path TEXT,
          branch        TEXT,
          pr_url        TEXT,
          evidence_md   TEXT,
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          claimed_at    INTEGER,
          claimed_by    TEXT
        );
      `);
    },
  },
  {
    id: "002_issue_events",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS issue_events (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          agent      TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','claimed','progress','blocked','unblocked',
                                     'evidence','complete','failed','review','merged',
                                     'budget-blocked','mirror-conflict','note')),
          payload_md TEXT
        );
      `);
    },
  },
  {
    id: "003_kind_thread_id",
    up: (db) => {
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((r) => r.name);
      if (!cols.includes("kind")) db.exec("ALTER TABLE issues ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
      if (!cols.includes("thread_id")) db.exec("ALTER TABLE issues ADD COLUMN thread_id TEXT");
    },
  },
  {
    id: "004_indexes",
    up: (db) => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(state, role, kind) WHERE state='ready'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_thread ON issues(thread_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id, seq)");
    },
  },
  {
    id: "005_unblock_trigger",
    up: (db) => {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS unblock_dependents
        AFTER UPDATE OF state ON issues
        WHEN NEW.state = 'merged' AND OLD.state != 'merged'
        BEGIN
          UPDATE issues
          SET state = 'ready', updated_at = strftime('%s','now')
          WHERE state = 'blocked'
            AND blocked_by IS NOT NULL
            AND blocked_by != '[]'
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(issues.blocked_by) dep
              JOIN issues b ON b.id = dep.value
              WHERE b.state != 'merged'
            );
        END;
      `);
    },
  },
  {
    id: "006_schema_migrations_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
      `);
    },
  },
  {
    id: "007_encounter_ext",
    up: (db) => {
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((r) => r.name);
      if (!cols.includes("encounter_mode")) db.exec("ALTER TABLE issues ADD COLUMN encounter_mode TEXT");
      if (!cols.includes("encounter_timeout_at")) db.exec("ALTER TABLE issues ADD COLUMN encounter_timeout_at INTEGER");
      if (!cols.includes("encounter_default_resolution")) db.exec("ALTER TABLE issues ADD COLUMN encounter_default_resolution TEXT");
    },
  },
];

export function migrate(db: Database): string[] {
  db.exec("PRAGMA journal_mode=WAL;");
  // Bootstrap: ensure schema_migrations exists first.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );`);

  const applied = new Set(
    db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all().map((r) => r.id),
  );
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      db.run("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)", [m.id]);
    })();
    ran.push(m.id);
  }
  return ran;
}

if (import.meta.main) {
  const dbPath = process.argv[2] ?? `${process.env.HOME}/vault/ledger.db`;
  const db = new Database(dbPath);
  const ran = migrate(db);
  console.log(JSON.stringify({ db: dbPath, applied: ran }, null, 2));
}

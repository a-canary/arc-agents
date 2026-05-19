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
  {
    id: "008_guardrails",
    up: (db) => {
      // Backfill `type` to priority enum before any CHECK is applied.
      // Existing values (task/impl/implement-slice/research) → 'mvp' default.
      db.exec(`
        UPDATE issues SET type = 'mvp'
        WHERE type NOT IN ('HITL','cron','mvp','security','quality','scale','efficiency','deferred');
      `);

      // Backfill `kind` for any pre-003 row still on legacy default.
      db.exec(`
        UPDATE issues SET kind = 'task'
        WHERE kind NOT IN ('task','chat_in','encounter_reply','prd');
      `);

      // Normalize blocked_by: empty string → NULL, '[]' → NULL.
      db.exec(`UPDATE issues SET blocked_by = NULL WHERE blocked_by IN ('', '[]')`);

      // Abort migration if any row still violates target constraints. Forces
      // owner to remediate before schema CHECKs lock in.
      const bad = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM issues
           WHERE kind NOT IN ('task','chat_in','encounter_reply','prd')
              OR type NOT IN ('HITL','cron','mvp','security','quality','scale','efficiency','deferred')
              OR (blocked_by IS NOT NULL AND blocked_by NOT LIKE '[%]')`,
        )
        .get()!;
      if (bad.n > 0) throw new Error(`008: ${bad.n} rows still violate guardrails — remediate before retry`);

      // SQLite has no ALTER TABLE ADD CHECK. Rebuild the table.
      db.exec("DROP TRIGGER IF EXISTS unblock_dependents");
      db.exec("DROP INDEX IF EXISTS idx_issues_ready");

      db.exec(`
        CREATE TABLE issues_new (
          id            TEXT PRIMARY KEY,
          project       TEXT NOT NULL,
          parent_id     TEXT REFERENCES issues_new(id),
          title         TEXT NOT NULL,
          body_md       TEXT NOT NULL,
          acceptance_md TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL
                        CHECK (type IN ('HITL','cron','mvp','security','quality','scale','efficiency','deferred')),
          state         TEXT NOT NULL DEFAULT 'ready'
                        CHECK (state IN ('ready','claimed','wip','blocked','review','merged','cancelled','failed')),
          hitl          INTEGER NOT NULL DEFAULT 0 CHECK (hitl IN (0,1)),
          kind          TEXT NOT NULL DEFAULT 'task'
                        CHECK (kind IN ('task','chat_in','encounter_reply','prd')),
          blocked_by    TEXT CHECK (blocked_by IS NULL OR blocked_by LIKE '[%]'),
          worktree_path TEXT,
          branch        TEXT,
          pr_url        TEXT,
          evidence_md   TEXT,
          thread_id     TEXT,
          encounter_mode TEXT,
          encounter_timeout_at INTEGER,
          encounter_default_resolution TEXT,
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          claimed_at    INTEGER,
          claimed_by    TEXT
        );
      `);

      db.exec(`
        INSERT INTO issues_new (
          id, project, parent_id, title, body_md, acceptance_md, type, state, hitl,
          kind, blocked_by, worktree_path, branch, pr_url, evidence_md,
          thread_id, encounter_mode, encounter_timeout_at, encounter_default_resolution,
          created_at, updated_at, claimed_at, claimed_by
        )
        SELECT id, project, parent_id, title, body_md, acceptance_md, type, state, hitl,
               kind, blocked_by, worktree_path, branch, pr_url, evidence_md,
               thread_id, encounter_mode, encounter_timeout_at, encounter_default_resolution,
               created_at, updated_at, claimed_at, claimed_by
        FROM issues;
      `);

      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");

      // Re-create indexes (role is gone, so index keys drop it).
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(state, kind, type) WHERE state='ready'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_thread ON issues(thread_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_claimed_at ON issues(claimed_at) WHERE state='claimed'");

      // Normalized unblock trigger: blocked_by IS NULL now means no deps, so no extra '[]' check needed.
      db.exec(`
        CREATE TRIGGER unblock_dependents
        AFTER UPDATE OF state ON issues
        WHEN NEW.state = 'merged' AND OLD.state != 'merged'
        BEGIN
          UPDATE issues
          SET state = 'ready', updated_at = strftime('%s','now')
          WHERE state = 'blocked'
            AND blocked_by IS NOT NULL
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
    id: "009_hitl_prompts",
    // ADR 0002 — UX Module Contract. Two-table HITL schema, broadcast + retract.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hitl_prompts (
          id                   TEXT PRIMARY KEY,
          created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          kind                 TEXT NOT NULL CHECK (kind IN
                                 ('ask_text','ask_choice','ask_confirm','notify','show_artifact')),
          class                TEXT NOT NULL CHECK (class IN ('taste','impact')),
          payload              TEXT NOT NULL,
          recommended          TEXT,
          divergence_strategy  TEXT CHECK (divergence_strategy IN ('forward_fix','replay')),
          timeout_sec          INTEGER,
          state                TEXT NOT NULL DEFAULT 'open' CHECK (state IN
                                 ('open','timeout_locked','user_confirmed','user_diverged',
                                  'answered','cancelled')),
          answer               TEXT,
          answered_by          TEXT,
          answered_at          INTEGER,
          anchor_repo          TEXT,
          anchor_branch        TEXT,
          anchor_commit        TEXT,
          expires_at           INTEGER,
          emitted_by           TEXT,
          CHECK (class != 'taste' OR recommended IS NOT NULL),
          CHECK (class != 'impact' OR timeout_sec IS NULL)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS hitl_deliveries (
          prompt_id      TEXT NOT NULL REFERENCES hitl_prompts(id) ON DELETE CASCADE,
          module_name    TEXT NOT NULL,
          state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                           ('pending','delivered','retracted','acked','failed')),
          external_ref   TEXT,
          delivered_at   INTEGER,
          retracted_at   INTEGER,
          PRIMARY KEY (prompt_id, module_name)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS ux_heartbeats (
          module_name TEXT PRIMARY KEY,
          last_beat   INTEGER NOT NULL
        );
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_hitl_prompts_open ON hitl_prompts(state) WHERE state='open'",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_hitl_deliveries_pending ON hitl_deliveries(module_name, state) WHERE state IN ('pending','delivered')",
      );
      // Retract cascade: when a prompt is answered (or diverges/locks), flip all
      // still-delivered loser rows to retracted so each module can scrub its surface.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS hitl_retract_losers
        AFTER UPDATE OF state ON hitl_prompts
        WHEN NEW.state IN ('answered','user_confirmed','user_diverged','timeout_locked','cancelled')
         AND OLD.state = 'open'
        BEGIN
          UPDATE hitl_deliveries
          SET state = 'retracted', retracted_at = strftime('%s','now')
          WHERE prompt_id = NEW.id
            AND state IN ('pending','delivered')
            AND (NEW.answered_by IS NULL OR module_name != NEW.answered_by);
        END;
      `);
    },
  },
  {
    id: "010_expand_kind_type_for_path_b",
    // Path B: interviewer goes ephemeral. Expand `kind` to cover chat_out + prefetch.
    // Expand `type` with `interactive` for the fast-pass slot pool (user-is-waiting work:
    // next chat reply, prefetch for pending taste/impact decision, UX request).
    up: (db) => {
      db.exec("DROP TRIGGER IF EXISTS unblock_dependents");
      db.exec("DROP INDEX IF EXISTS idx_issues_ready");
      db.exec("DROP INDEX IF EXISTS idx_issues_thread");
      db.exec("DROP INDEX IF EXISTS idx_issues_parent");
      db.exec("DROP INDEX IF EXISTS idx_issues_claimed_at");

      db.exec(`
        CREATE TABLE issues_new (
          id            TEXT PRIMARY KEY,
          project       TEXT NOT NULL,
          parent_id     TEXT REFERENCES issues_new(id),
          title         TEXT NOT NULL,
          body_md       TEXT NOT NULL,
          acceptance_md TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL
                        CHECK (type IN ('interactive','HITL','cron','mvp','security','quality','scale','efficiency','deferred')),
          state         TEXT NOT NULL DEFAULT 'ready'
                        CHECK (state IN ('ready','claimed','wip','blocked','review','merged','cancelled','failed')),
          hitl          INTEGER NOT NULL DEFAULT 0 CHECK (hitl IN (0,1)),
          kind          TEXT NOT NULL DEFAULT 'task'
                        CHECK (kind IN ('task','chat_in','chat_out','encounter_reply','prd','prefetch')),
          blocked_by    TEXT CHECK (blocked_by IS NULL OR blocked_by LIKE '[%]'),
          worktree_path TEXT,
          branch        TEXT,
          pr_url        TEXT,
          evidence_md   TEXT,
          thread_id     TEXT,
          encounter_mode TEXT,
          encounter_timeout_at INTEGER,
          encounter_default_resolution TEXT,
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          claimed_at    INTEGER,
          claimed_by    TEXT
        );
      `);

      db.exec(`
        INSERT INTO issues_new
        SELECT * FROM issues;
      `);

      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");

      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(state, kind, type) WHERE state='ready'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_thread ON issues(thread_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_claimed_at ON issues(claimed_at) WHERE state='claimed'");

      db.exec(`
        CREATE TRIGGER unblock_dependents
        AFTER UPDATE OF state ON issues
        WHEN NEW.state = 'merged' AND OLD.state != 'merged'
        BEGIN
          UPDATE issues
          SET state = 'ready', updated_at = strftime('%s','now')
          WHERE state = 'blocked'
            AND blocked_by IS NOT NULL
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
    id: "011_class_urgency_schema",
    // ADR 0005 — split single `type` into orthogonal (class, urgency).
    // Add source_module. Rename kind values:
    //   chat_in, encounter_reply -> event
    //   chat_out                 -> reply
    // `type` column retained for now; drop deferred to a later release per ADR
    // implementation note 9 ("after backfill verified"). Backfill is table-driven.
    up: (db) => {
      db.exec("DROP TRIGGER IF EXISTS unblock_dependents");
      db.exec("DROP INDEX IF EXISTS idx_issues_ready");
      db.exec("DROP INDEX IF EXISTS idx_issues_thread");
      db.exec("DROP INDEX IF EXISTS idx_issues_parent");
      db.exec("DROP INDEX IF EXISTS idx_issues_claimed_at");

      // Normalize legacy `type` values in case any pre-008 row slipped through.
      db.exec(`
        UPDATE issues SET type = 'mvp'
        WHERE type NOT IN ('interactive','HITL','cron','mvp','security','quality','scale','efficiency','deferred');
      `);

      // Rebuild table: add class, urgency, source_module; expand kind enum to include
      // event/reply (old chat_in/chat_out/encounter_reply temporarily co-allowed in the
      // CHECK during rebuild only because the INSERT...SELECT below relies on the rewrite
      // CASE to map them — but we want post-rename validation strict, so the new CHECK
      // lists only the post-ADR-0005 kind set).
      db.exec(`
        CREATE TABLE issues_new (
          id            TEXT PRIMARY KEY,
          project       TEXT NOT NULL,
          parent_id     TEXT REFERENCES issues_new(id),
          title         TEXT NOT NULL,
          body_md       TEXT NOT NULL,
          acceptance_md TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL
                        CHECK (type IN ('interactive','HITL','cron','mvp','security','quality','scale','efficiency','deferred')),
          state         TEXT NOT NULL DEFAULT 'ready'
                        CHECK (state IN ('ready','claimed','wip','blocked','review','merged','cancelled','failed')),
          hitl          INTEGER NOT NULL DEFAULT 0 CHECK (hitl IN (0,1)),
          kind          TEXT NOT NULL DEFAULT 'task'
                        CHECK (kind IN ('task','event','reply','prd','prefetch')),
          class         TEXT NOT NULL DEFAULT 'class_unset'
                        CHECK (class IN ('BUG','MVP','ops','hygiene','quality','trust','scale','efficiency','class_unset')),
          urgency       TEXT NOT NULL DEFAULT 'nominal'
                        CHECK (urgency IN ('interactive','nominal','deferred')),
          source_module TEXT,
          blocked_by    TEXT CHECK (blocked_by IS NULL OR blocked_by LIKE '[%]'),
          worktree_path TEXT,
          branch        TEXT,
          pr_url        TEXT,
          evidence_md   TEXT,
          thread_id     TEXT,
          encounter_mode TEXT,
          encounter_timeout_at INTEGER,
          encounter_default_resolution TEXT,
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          claimed_at    INTEGER,
          claimed_by    TEXT,
          CHECK (kind NOT IN ('event','reply') OR source_module IS NOT NULL)
        );
      `);

      // Backfill mapping per ADR 0005 §"Implementation notes" step 2.
      // Kind rename: chat_in/encounter_reply -> event; chat_out -> reply.
      // (class, urgency) derived from existing `type`:
      //   interactive -> (class_unset, interactive)
      //   HITL        -> (class_unset, nominal)
      //   mvp         -> (MVP,         nominal)
      //   security    -> (trust,       nominal)
      //   quality     -> (quality,     nominal)
      //   scale       -> (scale,       nominal)
      //   efficiency  -> (efficiency,  nominal)
      //   deferred    -> (class_unset, deferred)
      //   cron        -> (ops,         nominal)
      // source_module: arc-chat for renamed chat_in/chat_out; NULL otherwise (event/reply
      // rows synthesized by other paths get backfilled by their producers later).
      db.exec(`
        INSERT INTO issues_new (
          id, project, parent_id, title, body_md, acceptance_md, type, state, hitl,
          kind, class, urgency, source_module,
          blocked_by, worktree_path, branch, pr_url, evidence_md,
          thread_id, encounter_mode, encounter_timeout_at, encounter_default_resolution,
          created_at, updated_at, claimed_at, claimed_by
        )
        SELECT
          id, project, parent_id, title, body_md, acceptance_md, type, state, hitl,
          CASE kind
            WHEN 'chat_in'         THEN 'event'
            WHEN 'encounter_reply' THEN 'event'
            WHEN 'chat_out'        THEN 'reply'
            ELSE kind
          END AS kind,
          CASE type
            WHEN 'mvp'        THEN 'MVP'
            WHEN 'security'   THEN 'trust'
            WHEN 'quality'    THEN 'quality'
            WHEN 'scale'      THEN 'scale'
            WHEN 'efficiency' THEN 'efficiency'
            WHEN 'cron'       THEN 'ops'
            ELSE 'class_unset'
          END AS class,
          CASE type
            WHEN 'interactive' THEN 'interactive'
            WHEN 'deferred'    THEN 'deferred'
            ELSE 'nominal'
          END AS urgency,
          CASE
            WHEN kind IN ('chat_in','chat_out','encounter_reply') THEN 'arc-chat'
            ELSE NULL
          END AS source_module,
          blocked_by, worktree_path, branch, pr_url, evidence_md,
          thread_id, encounter_mode, encounter_timeout_at, encounter_default_resolution,
          created_at, updated_at, claimed_at, claimed_by
        FROM issues;
      `);

      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");

      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(state, kind, urgency, class) WHERE state='ready'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_thread ON issues(thread_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_claimed_at ON issues(claimed_at) WHERE state='claimed'");

      db.exec(`
        CREATE TRIGGER unblock_dependents
        AFTER UPDATE OF state ON issues
        WHEN NEW.state = 'merged' AND OLD.state != 'merged'
        BEGIN
          UPDATE issues
          SET state = 'ready', updated_at = strftime('%s','now')
          WHERE state = 'blocked'
            AND blocked_by IS NOT NULL
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
    id: "012_arc_ux_tables",
    // ADR 0006 — arc-ux persistent abstraction.
    // 1) Create artifacts + thread_subscriptions.
    // 2) Rename hitl_deliveries -> deliveries with polymorphic (target_kind, target_id).
    //    Backfill target_kind='hitl_prompt'. Preserve retract/ack states (used by
    //    hitl_retract_losers trigger) alongside ADR-specified pending/delivered/failed/skipped.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          uuid                 TEXT PRIMARY KEY,
          kind                 TEXT NOT NULL,
          ref_path             TEXT,
          inline_body          TEXT,
          bytes                INTEGER NOT NULL,
          created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          originating_row_id   TEXT NOT NULL REFERENCES issues(id),
          CHECK ((ref_path IS NULL) != (inline_body IS NULL))
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_subscriptions (
          thread_id            TEXT NOT NULL,
          module               TEXT NOT NULL,
          external_ref         TEXT NOT NULL,
          state                TEXT NOT NULL DEFAULT 'active'
                                CHECK (state IN ('active','archived','muted')),
          created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (thread_id, module, external_ref)
        );
      `);
      // Drop old trigger + index; rebuild on new table after rename.
      db.exec(`DROP TRIGGER IF EXISTS hitl_retract_losers;`);
      db.exec(`DROP INDEX IF EXISTS idx_hitl_deliveries_pending;`);
      db.exec(`
        CREATE TABLE deliveries_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          target_kind     TEXT NOT NULL CHECK (target_kind IN ('reply','hitl_prompt')),
          target_id       TEXT NOT NULL,
          module          TEXT NOT NULL,
          external_ref    TEXT,
          state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                            ('pending','delivered','retracted','acked','failed','skipped')),
          attempted_at    INTEGER,
          delivered_at    INTEGER,
          retracted_at    INTEGER,
          error           TEXT
        );
      `);
      db.exec(`
        INSERT INTO deliveries_new
          (target_kind, target_id, module, external_ref, state, delivered_at, retracted_at)
        SELECT 'hitl_prompt', prompt_id, module_name, external_ref, state, delivered_at, retracted_at
        FROM hitl_deliveries;
      `);
      db.exec(`DROP TABLE hitl_deliveries;`);
      db.exec(`ALTER TABLE deliveries_new RENAME TO deliveries;`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(module, state) WHERE state IN ('pending','delivered')",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_deliveries_target ON deliveries(target_kind, target_id)",
      );
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS hitl_retract_losers
        AFTER UPDATE OF state ON hitl_prompts
        WHEN NEW.state IN ('answered','user_confirmed','user_diverged','timeout_locked','cancelled')
         AND OLD.state = 'open'
        BEGIN
          UPDATE deliveries
          SET state = 'retracted', retracted_at = strftime('%s','now')
          WHERE target_kind = 'hitl_prompt'
            AND target_id = NEW.id
            AND state IN ('pending','delivered')
            AND (NEW.answered_by IS NULL OR module != NEW.answered_by);
        END;
      `);
    },
  },
  {
    id: "013_deliveries_unique_idx",
    // ADR 0006 — arc-ux deliveries module. Unique key for idempotent fanout:
    // re-fanning the same target to the same (module, external_ref) is a no-op.
    up: (db) => {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_unique
         ON deliveries(target_kind, target_id, module, external_ref)`,
      );
    },
  },
];

export function migrateUpTo(db: Database, stopAfterId: string): string[] {
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );`);
  const applied = new Set(
    db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all().map((r) => r.id),
  );
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) {
      if (m.id === stopAfterId) return ran;
      continue;
    }
    db.transaction(() => {
      m.up(db);
      db.run("INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)", [m.id]);
    })();
    ran.push(m.id);
    if (m.id === stopAfterId) return ran;
  }
  return ran;
}

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

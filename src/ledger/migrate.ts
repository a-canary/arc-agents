// Idempotent ledger schema migrations.
// Apply order is append-only. Each migration checks current state before running.

import { Database } from "bun:sqlite";
import { CLASS_VALUES, URGENCY_VALUES, sqlInList, TIER_VALUES, POOL_VALUES, AGENT_VALUES } from "./schema-enums";

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
      // CHECK lists for class/urgency are generated from schema-enums.ts to
      // keep migration 011 and the runtime validators on the same enum.
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
                        CHECK (class IN (${sqlInList(CLASS_VALUES)})),
          urgency       TEXT NOT NULL DEFAULT 'nominal'
                        CHECK (urgency IN (${sqlInList(URGENCY_VALUES)})),
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
    id: "012_webui_columns",
    // Add columns the webui needs:
    //   priority      INT  — numeric priority. Lower = sooner. Backfilled
    //                        from TYPE_PRIORITY (interactive=0…deferred=8)*10
    //                        so /triage-failed and /defer can mutate without
    //                        colliding with neighbors. Defer subtracts 100.
    //   paused        BOOL — webui pause toggle. Waiter/factory skip when true.
    //   deferred_at   TS   — set when the row was last deferred (rejoin queue).
    //   artifact_dir  TEXT — path under ~/vault/agents/<role>/artifacts/<row>/
    //                        for any drafts/sketches a worker produced.
    //   draft_md      TEXT — cached HITL panel draft body (S5/S8 pre-drafter).
    // parent_id already exists from 001/008/010/011 — no-op here.
    up: (db) => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(issues)")
        .all()
        .map((r) => r.name);
      if (!cols.includes("priority")) db.exec("ALTER TABLE issues ADD COLUMN priority INTEGER");
      if (!cols.includes("paused"))
        db.exec("ALTER TABLE issues ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1))");
      if (!cols.includes("deferred_at")) db.exec("ALTER TABLE issues ADD COLUMN deferred_at INTEGER");
      if (!cols.includes("artifact_dir")) db.exec("ALTER TABLE issues ADD COLUMN artifact_dir TEXT");
      if (!cols.includes("draft_md")) db.exec("ALTER TABLE issues ADD COLUMN draft_md TEXT");

      // Backfill priority from TYPE_PRIORITY * 10 so defer (-100) and manual
      // bumps have headroom without colliding with the type bucket.
      db.exec(`
        UPDATE issues SET priority = CASE type
          WHEN 'interactive' THEN 0
          WHEN 'HITL'        THEN 10
          WHEN 'cron'        THEN 20
          WHEN 'mvp'         THEN 30
          WHEN 'security'    THEN 40
          WHEN 'quality'     THEN 50
          WHEN 'scale'       THEN 60
          WHEN 'efficiency'  THEN 70
          WHEN 'deferred'    THEN 80
          ELSE 999
        END
        WHERE priority IS NULL;
      `);

      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority) WHERE state='ready'");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_paused ON issues(paused) WHERE paused=1");
    },
  },
  {
    id: "013_event_kind_reclaimed",
    // Expand issue_events.kind CHECK to include 'reclaimed', emitted by
    // claim-stale-sweeper so operators have a forensic trail of which worker
    // hung and for how long before its claim was reset.
    up: (db) => {
      db.exec(`
        CREATE TABLE issue_events_new (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          agent      TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','claimed','progress','blocked','unblocked',
                                     'evidence','complete','failed','review','merged',
                                     'budget-blocked','mirror-conflict','note','reclaimed')),
          payload_md TEXT
        );
      `);
      db.exec(`
        INSERT INTO issue_events_new (seq, issue_id, ts, agent, kind, payload_md)
        SELECT seq, issue_id, ts, agent, kind, payload_md FROM issue_events;
      `);
      db.exec("DROP TABLE issue_events");
      db.exec("ALTER TABLE issue_events_new RENAME TO issue_events");
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id, seq)");
    },
  },
  {
    id: "014_event_kind_diff_review",
    // Expand issue_events.kind CHECK to include 'diff_review'. The ledger
    // CLI's merge gate (bin/ledger.ts update --state=merged) requires a
    // prior diff_review event; without this kind in the CHECK, the gate is
    // unsatisfiable.
    up: (db) => {
      db.exec(`
        CREATE TABLE issue_events_new (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          agent      TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','claimed','progress','blocked','unblocked',
                                     'evidence','complete','failed','review','merged',
                                     'budget-blocked','mirror-conflict','note','reclaimed',
                                     'diff_review')),
          payload_md TEXT
        );
      `);
      db.exec(`
        INSERT INTO issue_events_new (seq, issue_id, ts, agent, kind, payload_md)
        SELECT seq, issue_id, ts, agent, kind, payload_md FROM issue_events;
      `);
      db.exec("DROP TABLE issue_events");
      db.exec("ALTER TABLE issue_events_new RENAME TO issue_events");
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id, seq)");
    },
  },
  {
    id: "015_null_claim_on_nonclaim_state",
    // Backfill: prior decompose/update paths flipped state to blocked/failed
    // without clearing claimed_by/claimed_at, leaving phantom claims that
    // confuse dashboards and the wait-for-ledger counter (which checks
    // claimed_by IS NULL on ready rows only — but blocked rows still bleed
    // through to /list views and orphan audits). Fix the write paths in
    // bin/ledger.ts, then backfill historical rows here.
    up: (db) => {
      db.exec(`
        UPDATE issues
        SET claimed_by = NULL, claimed_at = NULL
        WHERE state IN ('blocked','ready','failed','cancelled')
          AND (claimed_by IS NOT NULL OR claimed_at IS NOT NULL);
      `);
    },
  },
  {
    id: "017_class_urgency_to_tier_pool",
    // Rename the two classification axes and add a profile-selector column.
    //   class   → tier  (priority-queue rank). New TIER_VALUES enum.
    //   urgency → pool  (worker-lane). New POOL_VALUES enum.
    //   +agent         (profile selector). New AGENT_VALUES enum.
    //   -priority      (half-abandoned integer axis; NULL on ~75% of rows).
    // Sort order inverts: tier-MAJOR / pool-MINOR (was urgency-MAJOR/class-MINOR).
    //
    // COLUMN-RESILIENT: the live DB has out-of-tree columns not present in the
    // 001–015 fixture (product, paused, deferred_at, artifact_dir, draft_md).
    // We use PRAGMA table_info to discover the actual live column set and carry
    // every column forward 1:1 except the three we rename/drop/add.
    //
    // REMAP semantics (lossless only — sets *_unset where no 1:1 exists):
    //   class=trust/hygiene/quality/scale/efficiency → tier=same
    //   class=MVP → tier=mvp (case-normalize)
    //   class=ops → tier=tier_unset (ops is now a pool, not a tier)
    //   class=BUG/class_unset → tier=tier_unset
    //   class=ops → pool=ops (regardless of urgency)
    //   urgency=interactive (non-ops) → pool=interactive
    //   urgency=nominal/deferred → pool=pool_unset
    //   kind=prd OR source_module=arc-chat → agent=chat
    //   else → agent=agent_unset
    //
    // Runs OUTSIDE an explicit transaction: migrate() wraps each migration
    // in db.transaction(...)(). Do NOT open your own transaction here.
    up: (db) => {
      // ── Drop dependent indexes and trigger ───────────────────────────────
      db.exec("DROP TRIGGER IF EXISTS unblock_dependents");
      db.exec("DROP INDEX IF EXISTS idx_issues_ready");
      db.exec("DROP INDEX IF EXISTS idx_issues_thread");
      db.exec("DROP INDEX IF EXISTS idx_issues_parent");
      db.exec("DROP INDEX IF EXISTS idx_issues_claimed_at");
      db.exec("DROP INDEX IF EXISTS idx_issues_priority");
      db.exec("DROP INDEX IF EXISTS idx_issues_paused");
      db.exec("DROP INDEX IF EXISTS idx_issues_product");

      // ── Discover actual live column set via PRAGMA ────────────────────────
      const allCols = db
        .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
          "PRAGMA table_info(issues)",
        )
        .all();

      // Columns to remove entirely from the new table
      const DROP_COLS = new Set(["class", "urgency", "priority"]);
      // Columns being renamed (old name → new name); handled via CASE in SELECT
      const RENAME_MAP: Record<string, string> = {
        class: "tier",
        urgency: "pool",
      };

      // Columns that carry through unchanged (excluding dropped + renamed)
      const passThroughCols = allCols
        .map((c) => c.name)
        .filter((n) => !DROP_COLS.has(n));

      // ── Build CREATE TABLE issues_new ─────────────────────────────────────
      // We enumerate the DDL column list by keeping the original DDL for
      // pass-through columns and synthesizing new definitions for tier/pool/agent.
      // We insert tier/pool at the position where class/urgency were (after kind),
      // then append agent, then any remaining pass-through cols.
      //
      // Approach: build an ordered column list by walking allCols, substituting:
      //   class → tier (new def)
      //   urgency → pool (new def)
      //   priority → (skip)
      // Then append agent at the end (it's genuinely new).
      // Unknown/out-of-tree cols (product, paused, etc.) pass through via their
      // original definition string.

      const colDefs: string[] = [];
      const seenPos: { foundClass: boolean; foundUrgency: boolean } = {
        foundClass: false,
        foundUrgency: false,
      };

      for (const col of allCols) {
        if (col.name === "priority") continue; // DROP

        if (col.name === "class") {
          seenPos.foundClass = true;
          colDefs.push(
            `tier TEXT NOT NULL DEFAULT 'tier_unset' CHECK (tier IN (${sqlInList(TIER_VALUES)}))`,
          );
          continue;
        }

        if (col.name === "urgency") {
          seenPos.foundUrgency = true;
          colDefs.push(
            `pool TEXT NOT NULL DEFAULT 'pool_unset' CHECK (pool IN (${sqlInList(POOL_VALUES)}))`,
          );
          continue;
        }

        // Pass-through: reconstruct the column definition from PRAGMA info.
        // PRAGMA does NOT return inline CHECK constraints, so we hardcode the
        // checks for every known constrained column.  Out-of-tree columns (e.g.
        // product, paused, deferred_at, artifact_dir, draft_md) are carried
        // forward with only NOT NULL + DEFAULT; they have no CHECKs to restore.
        const KNOWN_COL_CHECKS: Record<string, string> = {
          type: `CHECK (type IN ('interactive','HITL','cron','mvp','security','quality','scale','efficiency','deferred'))`,
          state: `CHECK (state IN ('ready','claimed','wip','blocked','review','merged','cancelled','failed'))`,
          hitl: `CHECK (hitl IN (0,1))`,
          kind: `CHECK (kind IN ('task','event','reply','prd','prefetch'))`,
          blocked_by: `CHECK (blocked_by IS NULL OR blocked_by LIKE '[%]')`,
          paused: `CHECK (paused IN (0,1))`,
          // parent_id gets REFERENCES below via special-case
        };

        let def = `${col.name} ${col.type || "TEXT"}`;
        if (col.pk === 1) {
          def += " PRIMARY KEY";
        } else {
          if (col.notnull) def += " NOT NULL";
          if (col.dflt_value !== null) {
            // PRAGMA returns the stored expression; if it contains '(' (e.g. strftime(…))
            // SQLite requires it wrapped in parens in CREATE TABLE: DEFAULT (expr).
            // Literal values ('text', 0, '') do not need wrapping.
            const dflt = col.dflt_value;
            def += dflt.includes("(") ? ` DEFAULT (${dflt})` : ` DEFAULT ${dflt}`;
          }
          if (KNOWN_COL_CHECKS[col.name]) def += ` ${KNOWN_COL_CHECKS[col.name]}`;
          if (col.name === "parent_id") def += ` REFERENCES issues_new(id)`;
        }
        colDefs.push(def);
      }

      // Append net-new agent column
      colDefs.push(
        `agent TEXT NOT NULL DEFAULT 'agent_unset' CHECK (agent IN (${sqlInList(AGENT_VALUES)}))`,
      );

      // Only multi-column table-level CHECKs go here. Per-column CHECKs are
      // inlined in the colDefs above via KNOWN_COL_CHECKS.
      const tableChecks = [
        `CHECK (kind NOT IN ('event','reply') OR source_module IS NOT NULL)`,
      ];

      db.exec(`
        CREATE TABLE issues_new (
          ${colDefs.join(",\n          ")},
          ${tableChecks.join(",\n          ")}
        );
      `);

      // ── INSERT with CASE remaps ───────────────────────────────────────────
      // Build the SELECT column list. For pass-through columns it's just the name.
      // For renamed columns we emit a CASE expression aliased to the new name.
      const selectParts: string[] = [];
      const insertCols: string[] = [];

      for (const col of allCols) {
        if (col.name === "priority") continue; // DROP

        if (col.name === "class") {
          // tier CASE remap
          insertCols.push("tier");
          selectParts.push(`
            CASE class
              WHEN 'trust'      THEN 'trust'
              WHEN 'MVP'        THEN 'mvp'
              WHEN 'hygiene'    THEN 'hygiene'
              WHEN 'quality'    THEN 'quality'
              WHEN 'scale'      THEN 'scale'
              WHEN 'efficiency' THEN 'efficiency'
              ELSE 'tier_unset'
            END AS tier`);
          continue;
        }

        if (col.name === "urgency") {
          // pool CASE remap — class=ops overrides urgency regardless
          insertCols.push("pool");
          selectParts.push(`
            CASE
              WHEN class = 'ops'             THEN 'ops'
              WHEN urgency = 'interactive'   THEN 'interactive'
              ELSE 'pool_unset'
            END AS pool`);
          continue;
        }

        insertCols.push(col.name);
        selectParts.push(col.name);
      }

      // Append agent (net-new)
      insertCols.push("agent");
      selectParts.push(`
        CASE
          WHEN kind = 'prd'                      THEN 'chat'
          WHEN source_module = 'arc-chat'        THEN 'chat'
          ELSE 'agent_unset'
        END AS agent`);

      db.exec(`
        INSERT INTO issues_new (${insertCols.join(", ")})
        SELECT ${selectParts.join(",\n        ")}
        FROM issues;
      `);

      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");

      // ── Recreate indexes ──────────────────────────────────────────────────
      // idx_issues_ready: updated to new column tuple (state, kind, tier, pool)
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(state, kind, tier, pool) WHERE state='ready'",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_thread ON issues(thread_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_issues_claimed_at ON issues(claimed_at) WHERE state='claimed'",
      );
      // Conditional indexes: only if the column exists (they're out-of-tree cols).
      const finalCols = new Set(
        db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((c) => c.name),
      );
      if (finalCols.has("paused")) {
        db.exec("CREATE INDEX IF NOT EXISTS idx_issues_paused ON issues(paused) WHERE paused=1");
      }
      if (finalCols.has("product")) {
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_issues_product ON issues(product) WHERE product IS NOT NULL",
        );
      }

      // ── Recreate unblock_dependents trigger (verbatim from migration 011) ─
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
    id: "018_event_kind_triaged",
    // Expand issue_events.kind CHECK to include 'triaged', emitted by
    // triageUnset() in factory.ts when it fills agent_unset/pool_unset sentinels
    // on ready rows. Gives operators a forensic trail of which rows were
    // auto-classified and what values were assigned.
    up: (db) => {
      db.exec(`
        CREATE TABLE issue_events_new (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          agent      TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','claimed','progress','blocked','unblocked',
                                     'evidence','complete','failed','review','merged',
                                     'budget-blocked','mirror-conflict','note','reclaimed',
                                     'diff_review','triaged')),
          payload_md TEXT
        );
      `);
      db.exec(`
        INSERT INTO issue_events_new (seq, issue_id, ts, agent, kind, payload_md)
        SELECT seq, issue_id, ts, agent, kind, payload_md FROM issue_events;
      `);
      db.exec("DROP TABLE issue_events");
      db.exec("ALTER TABLE issue_events_new RENAME TO issue_events");
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id, seq)");
    },
  },
  {
    id: "019_issue_kind_sprint",
    // Extend issues.kind CHECK to admit 'sprint'. SQLite cannot ALTER a CHECK
    // constraint, so we do a column-resilient table rebuild mirroring 017's pattern.
    //
    // Also widens the unblock_dependents trigger and adds unblock_sprint_parents so
    // sprint parents re-ready when ALL blockers reach a terminal state
    // (merged|failed|cancelled), not just merged. Non-sprint parents keep strict
    // merged-only semantics.
    //
    // Runs OUTSIDE an explicit transaction — migrate() wraps each up in
    // db.transaction(...)().  Do NOT open your own BEGIN/COMMIT here.
    up: (db) => {
      // ── Drop dependent trigger and indexes ──────────────────────────────────
      db.exec("DROP TRIGGER IF EXISTS unblock_dependents");
      db.exec("DROP TRIGGER IF EXISTS unblock_sprint_parents");
      db.exec("DROP INDEX IF EXISTS idx_issues_ready");
      db.exec("DROP INDEX IF EXISTS idx_issues_thread");
      db.exec("DROP INDEX IF EXISTS idx_issues_parent");
      db.exec("DROP INDEX IF EXISTS idx_issues_claimed_at");
      db.exec("DROP INDEX IF EXISTS idx_issues_priority");
      db.exec("DROP INDEX IF EXISTS idx_issues_paused");
      db.exec("DROP INDEX IF EXISTS idx_issues_product");

      // ── Discover actual live column set via PRAGMA ───────────────────────────
      const allCols = db
        .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
          "PRAGMA table_info(issues)",
        )
        .all();

      // ── KNOWN_COL_CHECKS: per-column CHECK constraints ───────────────────────
      // PRAGMA table_info does NOT return inline CHECKs, so every constrained
      // column must be listed here. Columns that already existed post-017
      // (tier, pool, agent) are pass-through rows — they need their CHECKs
      // re-listed here or the rebuild silently drops them.
      const KNOWN_COL_CHECKS_019: Record<string, string> = {
        type: `CHECK (type IN ('interactive','HITL','cron','mvp','security','quality','scale','efficiency','deferred'))`,
        state: `CHECK (state IN ('ready','claimed','wip','blocked','review','merged','cancelled','failed'))`,
        hitl: `CHECK (hitl IN (0,1))`,
        // 019 change: 'sprint' added to the kind CHECK.
        kind: `CHECK (kind IN ('task','event','reply','prd','prefetch','sprint'))`,
        blocked_by: `CHECK (blocked_by IS NULL OR blocked_by LIKE '[%]')`,
        paused: `CHECK (paused IN (0,1))`,
        // Post-017 pass-through columns: CHECKs must be re-listed (PRAGMA loses them).
        tier: `CHECK (tier IN (${sqlInList(TIER_VALUES)}))`,
        pool: `CHECK (pool IN (${sqlInList(POOL_VALUES)}))`,
        agent: `CHECK (agent IN (${sqlInList(AGENT_VALUES)}))`,
        // parent_id gets REFERENCES below via special-case
      };

      // ── Build CREATE TABLE issues_new ────────────────────────────────────────
      const colDefs: string[] = [];

      for (const col of allCols) {
        let def = `${col.name} ${col.type || "TEXT"}`;
        if (col.pk === 1) {
          def += " PRIMARY KEY";
        } else {
          if (col.notnull) def += " NOT NULL";
          if (col.dflt_value !== null) {
            const dflt = col.dflt_value;
            def += dflt.includes("(") ? ` DEFAULT (${dflt})` : ` DEFAULT ${dflt}`;
          }
          if (KNOWN_COL_CHECKS_019[col.name]) def += ` ${KNOWN_COL_CHECKS_019[col.name]}`;
          if (col.name === "parent_id") def += ` REFERENCES issues_new(id)`;
        }
        colDefs.push(def);
      }

      // Only multi-column table-level CHECKs go here.
      const tableChecks = [
        `CHECK (kind NOT IN ('event','reply') OR source_module IS NOT NULL)`,
      ];

      db.exec(`
        CREATE TABLE issues_new (
          ${colDefs.join(",\n          ")},
          ${tableChecks.join(",\n          ")}
        );
      `);

      // ── Straight INSERT…SELECT (no remaps — 019 only widens a CHECK) ─────────
      const colNames = allCols.map((c) => c.name);
      db.exec(`
        INSERT INTO issues_new (${colNames.join(", ")})
        SELECT ${colNames.join(", ")}
        FROM issues;
      `);

      db.exec("DROP TABLE issues");
      db.exec("ALTER TABLE issues_new RENAME TO issues");

      // ── Recreate indexes (same set as 017) ───────────────────────────────────
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_issues_ready ON issues(state, kind, tier, pool) WHERE state='ready'",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_thread ON issues(thread_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_issues_claimed_at ON issues(claimed_at) WHERE state='claimed'",
      );
      // Conditional indexes for out-of-tree columns.
      const finalCols = new Set(
        db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((c) => c.name),
      );
      if (finalCols.has("paused")) {
        db.exec("CREATE INDEX IF NOT EXISTS idx_issues_paused ON issues(paused) WHERE paused=1");
      }
      if (finalCols.has("product")) {
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_issues_product ON issues(product) WHERE product IS NOT NULL",
        );
      }

      // ── Recreate WIDENED trigger pair (change #4) ────────────────────────────
      // NOTE: Future issues-table rebuilds must recreate BOTH of these triggers,
      // not the verbatim single-trigger from migration 011/017.

      // unblock_dependents: unchanged semantics for NON-sprint parents (strict merged-only).
      // Added: AND kind != 'sprint' so sprint parents are handled by the second trigger.
      db.exec(`
        CREATE TRIGGER unblock_dependents
        AFTER UPDATE OF state ON issues
        WHEN NEW.state = 'merged' AND OLD.state != 'merged'
        BEGIN
          UPDATE issues
          SET state = 'ready', updated_at = strftime('%s','now')
          WHERE state = 'blocked'
            AND blocked_by IS NOT NULL
            AND kind != 'sprint'
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(issues.blocked_by) dep
              JOIN issues b ON b.id = dep.value
              WHERE b.state != 'merged'
            );
        END;
      `);

      // unblock_sprint_parents: sprint parents re-ready when ALL blockers are terminal.
      // Fires on any terminal child state (merged|failed|cancelled).
      db.exec(`
        CREATE TRIGGER unblock_sprint_parents
        AFTER UPDATE OF state ON issues
        WHEN NEW.state IN ('merged','failed','cancelled')
         AND OLD.state NOT IN ('merged','failed','cancelled')
        BEGIN
          UPDATE issues
          SET state = 'ready', updated_at = strftime('%s','now')
          WHERE state = 'blocked'
            AND blocked_by IS NOT NULL
            AND kind = 'sprint'
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(issues.blocked_by) dep
              JOIN issues b ON b.id = dep.value
              WHERE b.state NOT IN ('merged','failed','cancelled')
            );
        END;
      `);
    },
  },
  {
    id: "020_blog_table",
    // ADR 0007 — Blog Feed. Separate table for human-readable posts, not a polymorphic kind.
    // Columns: id, project, title, body_md, artifact_path, origin_task_id, created_at.
    // origin_task_id nullable — manual posts (e.g. from the blog skill) have no origin.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blog (
          id             TEXT PRIMARY KEY,
          project        TEXT NOT NULL,
          title          TEXT NOT NULL,
          body_md        TEXT NOT NULL,
          artifact_path  TEXT,
          origin_task_id TEXT REFERENCES issues(id),
          created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_blog_project ON blog(project)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_blog_created_at ON blog(created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_blog_origin_task_id ON blog(origin_task_id) WHERE origin_task_id IS NOT NULL");
    },
  },
  {
    id: "021_hygiene_complete",
    // Fix worktree-reaper / hygiene-emit race. After `update --state=merged`, the
    // reaper could delete the cwd before hygiene-emit fires, leaving workers unable
    // to log hygiene followups. Gate: merged rows are reaped only when
    // hygiene_complete=1. The merged update sets hygiene_complete=0; hygiene-emit
    // flips it to 1 when --observed-in-task is provided. Failed/cancelled rows are
    // unaffected (no hygiene phase).
    up: (db) => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(issues)")
        .all()
        .map((r) => r.name);
      if (!cols.includes("hygiene_complete")) {
        db.exec(
          "ALTER TABLE issues ADD COLUMN hygiene_complete INTEGER NOT NULL DEFAULT 1 CHECK (hygiene_complete IN (0,1))",
        );
      }
    },
  },
  {
    id: "022_feedback_table",
    // Feedback intake for the self-guided portal. SUPERSET schema reconciling two
    // writers on the shared ledger.db: arc-webui's /feedback form (project, source,
    // submitter, body_md, theme_id) and the agent friction CLI (context, origin_task_id).
    // Idempotent: CREATE for fresh DBs, then ALTER-ADD any column a prior writer's
    // table lacked (arc-webui bootstraps its own subset via CREATE IF NOT EXISTS, so
    // this table may pre-exist with fewer columns).
    // ponytail: source is a free string, not CHECK'd. The CONTEXT.md domain model says
    // source == trust tier (end-user-untrusted|...|mission) but arc-webui's form writes
    // channels (direct|public|github). Unifying that vocabulary is the gated L1 domain
    // migration — add a CHECK (and/or a separate channel column) once it's decided.
    // fb-qupj RESOLVED (2026-06-22): the Proposal confirmation gate maps the channel to
    // a binary trust tier in code (feedback-aggregate.ts isTrusted — direct/mission/
    // operator = trusted, rest = untrusted). The schema CHECK / separate channel column
    // stays deferred: the gate reads the free-string source directly, no migration needed.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id             TEXT PRIMARY KEY,
          project        TEXT NOT NULL DEFAULT '',
          source         TEXT NOT NULL DEFAULT 'ai-agent',
          submitter      TEXT,
          body_md        TEXT NOT NULL,
          context        TEXT,
          origin_task_id TEXT REFERENCES issues(id),
          theme_id       TEXT,
          -- DEFAULT/writes stay 'new'/'resolved' (arc-agents vocab). CHECK is a superset
          -- that also tolerates arc-webui's 'OPEN'/'DEV'/'CLOSED' so foreign-written rows
          -- (the live webui-owned feedback table has no CHECK) are valid here too.
          state          TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','OPEN','DEV','CLOSED','resolved')),
          created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
      `);
      // Backfill columns onto a table an earlier writer created with a narrower shape.
      const cols = new Set(
        db.query<{ name: string }, []>("PRAGMA table_info(feedback)").all().map((r) => r.name),
      );
      const add = (name: string, decl: string) => {
        if (!cols.has(name)) db.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${decl}`);
      };
      add("submitter", "TEXT");
      add("context", "TEXT");
      add("origin_task_id", "TEXT REFERENCES issues(id)");
      add("theme_id", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_state ON feedback(state)");
    },
  },
  {
    id: "023_feedback_theme",
    // Append-only audit of LLM Collector rounds (CAM ledger, keyed project x round).
    // feedback-aggregate.ts writes one row per category it found in a run — INCLUDING
    // un-confirmed categories — so the portal can surface "category counts + patterns"
    // (the directive) regardless of whether a Proposal was drafted. prd_id links the
    // category to its PRD when the confirmation gate passed; null when it did not.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_theme (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          round_id   TEXT NOT NULL,
          project    TEXT NOT NULL DEFAULT '',
          label      TEXT NOT NULL,
          pattern    TEXT NOT NULL DEFAULT '',
          count      INTEGER NOT NULL DEFAULT 0,
          confirmed  INTEGER NOT NULL DEFAULT 0,
          trusted    INTEGER NOT NULL DEFAULT 0,
          untrusted  INTEGER NOT NULL DEFAULT 0,
          prd_id     TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_theme_project ON feedback_theme(project, created_at DESC)");
    },
  },
  {
    id: "024_feedback_stale_superseded",
    // 2-pass stale/superseded feedback substrate for feedback-aggregate.ts.
    // Pass 1 (Collector flag) writes stale_candidate_at + stale_candidate_prd_id; pass 2
    // (Validator) reads them and either promotes the row to state='resolved' with
    // resolution='superseded' or clears the tentative verdict. Both columns live
    // directly on feedback (no new table — fewer joins, same queryability, and the
    // task body explicitly allowed this shape).
    //
    // ponytail: resolution is a free TEXT not a CHECK'd enum. The only verdict pass 2
    // emits today is 'superseded'; future verdicts (e.g. 'duplicate') get added here
    // when a slice needs them, not speculatively.
    up: (db) => {
      const cols = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(feedback)")
          .all()
          .map((r) => r.name),
      );
      const add = (name: string, decl: string) => {
        if (!cols.has(name)) db.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${decl}`);
      };
      add("stale_candidate_at", "INTEGER");
      add("stale_candidate_prd_id", "TEXT");
      add("resolution", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_feedback_stale_candidate ON feedback(stale_candidate_at) WHERE stale_candidate_at IS NOT NULL",
      );
    },
  },
  {
    id: "025_feedback_mode_author_trust",
    // Explicit per-row trust + intent for the Proposal confirmation gate
    // (feedback-aggregate.ts isTrusted). Closes the source='direct' degeneracy:
    // arc-webui stamps EVERY row source='direct', so the channel-keyed gate treated
    // a single product-user webui row as the trusted operator and minted a PRD. The
    // gate now keys on author_trust first, falling back to the channel only for
    // legacy unstamped (NULL) rows.
    //   mode         — imperative|hypothesis. NULL = hypothesis (the safe default:
    //                  musings never auto-ship). No SQL DEFAULT — NULL is read as
    //                  hypothesis in code, no table rewrite.
    //   author_trust — operator|product. NULL = unstamped legacy row → channel fallback.
    // Additive + idempotent: ALTER-ADD only if absent (PRAGMA table_info), matching
    // 022/024 — this is the webui-co-owned feedback table which may already carry cols.
    // ponytail: no CHECK constraints — the live webui-owned feedback table carries no
    // CHECKs (see 022's rationale); intended values are documented, not enforced.
    up: (db) => {
      const cols = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(feedback)")
          .all()
          .map((r) => r.name),
      );
      const add = (name: string, decl: string) => {
        if (!cols.has(name)) db.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${decl}`);
      };
      add("mode", "TEXT");
      add("author_trust", "TEXT");
    },
  },
  {
    id: "026_event_kind_operator_landed",
    // Expand issue_events.kind CHECK to include 'operator_landed'. ADR-0008
    // Pattern 3 gap: a worker can fail (exit 124 / exit 1) on a compute-bearing
    // row BEFORE the operator finishes the vast.ai run; the artifacts land on
    // disk but the row stays state=failed with no audit trail of the operator's
    // completion. The operator now emits `bin/ledger.ts event <id> operator_landed
    // '{"artifact_dir":...,"receipt_sha256":...,"box_id":...}'` after the compute
    // lands; a future bookie transition failed->ready can be gated on this kind.
    // Same shape as 013/014/018 (CHECK-expand via table rebuild). Slot 026
    // because 025 is taken by 025_feedback_mode_author_trust on origin/main.
    up: (db) => {
      db.exec(`
        CREATE TABLE issue_events_new (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          ts         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          agent      TEXT NOT NULL,
          kind       TEXT NOT NULL
                     CHECK (kind IN ('created','claimed','progress','blocked','unblocked',
                                     'evidence','complete','failed','review','merged',
                                     'budget-blocked','mirror-conflict','note','reclaimed',
                                     'diff_review','triaged','operator_landed')),
          payload_md TEXT
        );
      `);
      db.exec(`
        INSERT INTO issue_events_new (seq, issue_id, ts, agent, kind, payload_md)
        SELECT seq, issue_id, ts, agent, kind, payload_md FROM issue_events;
      `);
      db.exec("DROP TABLE issue_events");
      db.exec("ALTER TABLE issue_events_new RENAME TO issue_events");
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id, seq)");
    },
  },
  {
    id: "027_feedback_declined_at",
    // Explicit don't-re-propose cooldown marker on dismissed feedback. PR #18
    // (arc-webui) sets state='resolved' + declined_at when a human rejects the
    // linked Proposal in the approval gate. Implemented here as
    // feedback-aggregate.markDeclined, exported so arc-webui can call it. The
    // Collector (feedback-aggregate.ts selectNewFeedback) skips rows where this
    // column is set, regardless of their state — the marker is the truth.
    //
    // Distinct from migration 024's stale_candidate_at (the Validator's tentative
    // verdict) and the Validator's final resolution='superseded' write. Both paths
    // produce the same observable effect (Collector skips the row); declined_at is
    // the dismiss verdict's authoritative column, supersede is the stale verdict's.
    //
    // Slot 027 because 025_feedback_mode_author_trust and 026_event_kind_operator_landed
    // are taken on origin/main. Nullable: null == "eligible for re-aggregation".
    // Idempotent ALTER follows the 022_feedback_table pattern: check PRAGMA first.
    up: (db) => {
      const cols = new Set(
        db.query<{ name: string }, []>("PRAGMA table_info(feedback)").all().map((r) => r.name),
      );
      if (!cols.has("declined_at")) {
        db.exec("ALTER TABLE feedback ADD COLUMN declined_at INTEGER");
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_feedback_declined_at ON feedback(declined_at) WHERE declined_at IS NOT NULL",
      );
    },
  },
  {
    id: "028_prd_relationships",
    // Pairwise PRD relationships required by `bin/plan-agent.ts` so a newly
    // emitted Proposal classifies itself against every existing in-flight /
    // recently-proposed PRD (orthogonal | replace | dependency | fork).
    //
    // Persistence: separate table (not a column on `issues`), because each PRD
    // has N relationships (one row per (prd_id, other_prd_id) pair), the kind
    // vocabulary is closed, and the lookup pattern is bidirectional. Out-of-scope:
    // cancellation enforcement at approval time — follow-up #4. Slot 028 because
    // 024-027 are taken on origin/main.
    //
    // No FK constraint on issues.state — a row may be in any state when its
    // relationships land; the kind describes what the relationship IS.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prd_relationships (
          prd_id        TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          other_prd_id  TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          kind          TEXT NOT NULL
                        CHECK (kind IN ('orthogonal','replace','dependency','fork')),
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (prd_id, other_prd_id)
        );
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_prd_relationships_prd ON prd_relationships(prd_id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_prd_relationships_other ON prd_relationships(other_prd_id)",
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

# arc-agents — PRD v1

Universal agent harness. Ledger-dispatched, interactive-pane runtime. Replaces `~/agents/` (framework), `~/.pi/` (legacy daemon), and the headless `claude -p` cycle model.

---

## 1. Mission

**M-1.** One framework defines agents, roles, skills, and dispatch — runs across CLI runtimes (claude code primary; pi/qwen/opencode adapters). Agents defined once, deployed universally.

**M-2.** Dispatch is a **SQLite ledger** at `~/vault/ledger.db`. Every unit of work — task, chat, encounter, proposal — is a row. State transitions are atomic SQL. No daemons, no IPC sockets, no devd.

**M-3.** Runtime is **always-on interactive claude panes**, not headless `claude -p` subprocesses. Primary reason: transparency and observability — every worker is a live tmux pane you can attach to, watch tool use in real time, intervene mid-flight, and inspect after the fact via scrollback. Side benefit: interactive panes bill against the Max plan's Claude-Code bucket rather than the extra-usage/API bucket, which matters if Max with extra-usage off is the subscription shape in play.

**M-4.** Every session does **ke-recall** on start and **ke-learn** on stop. Knowledge compounds in `~/vault/ke/` (FTS5 + Qdrant). Deprecated `~/kb/`.

---

## 2. Architecture

### A-1. Three-tier layout
```
~/repos/<name>/              canonical clone, tracks main, read-mostly
~/worktrees/<repo>-<slug>/   dev work, one slice per worktree
~/vault/                     portfolio state (ledger.db, agents/, ke/, scratch/)
<repo>/.private/             per-repo gitignored local state
```

**arc- prefix** for user-owned repos: `arc-agents`, `arc-webui`. Third-party repos keep upstream name.

### A-2. Three roles
| Role | Scope | Workspace |
|---|---|---|
| **Director** | Portfolio orchestration, user comms, delegation. Sole human interface. | `~/vault/agents/director/` |
| **Developer** | Code execution within a repo's CHOICES.md. Spawned per worktree. | `~/worktrees/<repo>-<slug>/` |
| **Admin** | System, infra, secrets, security. Watches others for leaks/runaway-spend. | `~/vault/agents/admin/` |

Agent selection by cwd priority:
1. `~/vault/agents/admin/` → Admin
2. `~/vault/agents/director/` → Director
3. `~/worktrees/<repo>-*/` → Developer
4. `~/repos/<name>/` → Developer (read-mostly)
5. *fallback* → Director

### A-3. Tmux pane pattern
1 interviewer pane + N worker panes (default 3: developer / specialist / admin). Each pane = always-on claude session in `/loop 5m`. Wakes via `wait-for-ledger.ts` emitting JSON on stdout when claimable rows appear.

### A-4. Vault overrides repo
Where both exist, vault private state wins. Repo is version-controlled and shareable; vault is never pushed.

---

## 3. Ledger Schema

### Tables
```sql
CREATE TABLE issues (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN
                 ('task','chat_in','chat_out','encounter','encounter_reply','proposal')),
  role          TEXT,                    -- 'developer' | 'admin' | 'director' | NULL
  parent_id     INTEGER REFERENCES issues(id),
  thread_id     TEXT,                    -- groups chat/encounter exchanges
  repo          TEXT,                    -- arc-agents, arc-webui, ...
  slug          TEXT,                    -- worktree slug
  title         TEXT NOT NULL,
  body          TEXT,                    -- markdown
  state         TEXT NOT NULL CHECK(state IN
                 ('ready','claimed','wip','blocked','review','merged','cancelled','failed')),
  hitl          INTEGER NOT NULL DEFAULT 0,
  claimed_by    TEXT,
  claimed_at    TEXT,
  blockers      TEXT,                    -- JSON array of issue ids
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE issue_events (
  id         INTEGER PRIMARY KEY,
  issue_id   INTEGER NOT NULL REFERENCES issues(id),
  kind       TEXT NOT NULL,              -- 'state','comment','claim','release','merge'
  actor      TEXT NOT NULL,
  payload    TEXT,                       -- JSON
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_issues_ready ON issues(state, role, kind) WHERE state='ready';
CREATE INDEX idx_issues_thread ON issues(thread_id);
CREATE INDEX idx_issues_parent ON issues(parent_id);
```

### Trigger: cascade-on-merge
When an issue flips to `merged`, dependents with all blockers merged auto-flip `blocked` → `ready`.

```sql
CREATE TRIGGER unblock_dependents AFTER UPDATE OF state ON issues
WHEN NEW.state='merged' AND OLD.state!='merged'
BEGIN
  UPDATE issues SET state='ready', updated_at=datetime('now')
  WHERE state='blocked'
    AND EXISTS (SELECT 1 FROM json_each(blockers) WHERE value=NEW.id)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(blockers) je
      JOIN issues b ON b.id=je.value
      WHERE b.state != 'merged'
    );
END;
```

---

## 4. CLI surface (`ledger` / `bookie`)

```
ledger init                       create db, run migrations
ledger create <kind> <role?> <title>  insert row
ledger claim <role> <worker>      atomic UPDATE ... WHERE state='ready' RETURNING id
ledger update <id> --state <s>    state transition + event
ledger event <id> <kind> <payload>
ledger list [--role] [--state] [--kind]
ledger show <id>
ledger tick                       cascade-on-merge sweep (backstop)
ledger spawn-ready                emit JSON for ready rows (poll mode)
ledger compact                    archive merged/cancelled > 30d
ledger vacuum
```

Atomic claim:
```sql
UPDATE issues SET state='claimed', claimed_by=?, claimed_at=datetime('now')
WHERE id=(SELECT id FROM issues
          WHERE state='ready' AND kind='task' AND role=?
          ORDER BY id LIMIT 1)
RETURNING id;
```

---

## 5. Role profiles

`~/repos/arc-agents/profiles/<role>.json`:
```json
{
  "context_summary": "string",
  "boot_skills": ["ke-recall","spawn"],
  "stop_skills": ["ke-learn"],
  "model": "claude-opus-4-7",
  "thinking": "off",
  "effort": "max",
  "daily_budget_usd": 10,
  "speculative_budget": 2,
  "max_concurrency": 1,
  "worktree": true
}
```

Two-tier model policy: Opus 4.7 for synthesis (cap $10/day); minimax-m2.7 for bulk impl (unlimited, via direct API).

---

## 6. Lifecycle

- **No cycles, no nap-sleep.** Panes run continuously. Compact/vacuum/budget-rotate via cron (only retained crons).
- **`/checkin`** on demand.
- **HITL:** worker sets `state='blocked', hitl=1`, inserts child `kind='encounter'`. Interviewer pane surfaces it. User reply → `encounter_reply` → worker unblocks.
- **Worktree-per-issue:** Developer always spawns into `~/worktrees/<repo>-<slug>/`. Never edits `~/repos/<name>/` directly.
- **Slug-primary naming.** Collision → append `-<xxxx>` short id.

---

## 7. Skills (mandatory)

1. `ke-recall` — session start, FTS5+Qdrant search against `~/vault/ke/`
2. `ke-learn` — session stop, queue distilled learnings
3. `spawn` — write task row via bookie (no direct process spawn)

Other core skills live in `~/repos/arc-agents/skills/`.

---

## 8. Data

- `~/vault/ledger.db` — single source of truth for work state
- `~/vault/ke/` — knowledge engine (notes, evidence, vectors)
- `~/vault/agents/<role>/` — per-role memory, inbox, journal, outbox
- `~/vault/scratch/<slug>/` — prototype outputs from `/grill-me` → `/choose-wisely`

---

## 9. Approval gates

User approval (Discord) required: public commits/posts/releases, new project creation, major architectural changes, deleting significant code.

AI decides: low-level impl within approved scope.

---

## 10. Out of scope (v1)

- Multi-user. Single operator (aaron).
- Cross-machine sync. Single host.
- Web UI (lives in `arc-webui`, depends on this).
- GitHub Issues mirror. Ledger is local-first.

---

## 11. Retires

On adoption, retire from `~/agents/`:
- `bin/devd.ts`, `bin/cycle.ts`
- `dispatcher_registry.py`
- `~/vault/agents/dev-<project>/` (legacy per-project Developer homes)
- `~/kb/` (already migrated to `~/vault/ke/`)
- pi daemon, pulse.json, .bsh

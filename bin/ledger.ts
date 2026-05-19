#!/usr/bin/env bun
// Ledger CLI. Flag-only create per PRD-v1 §4; positional args are rejected.
// JSON to stdout when not a TTY; table otherwise.

import { open, openWithMigrate, mintId } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { validateCreate, validateDecompose, validateStateTransition, type CreateInput } from "../src/ledger/bookie-validator";
import { TYPE_PRIORITY_SQL } from "../src/ledger/type-priority-sort";
import { sweepStaleClaims } from "../src/ledger/claim-stale-sweeper";
import { renderSystemPrompt } from "../src/worker/templates";
import { loadConfig, pickModulesForHitl } from "../src/ledger/ux-config";
import type { HitlKind } from "../src/ledger/hitl-schemas";

const args = process.argv.slice(2);
const cmd = args[0];

function out(data: unknown): void {
  if (process.stdout.isTTY && Array.isArray(data)) {
    if (data.length === 0) {
      console.log("(empty)");
      return;
    }
    const rows = data as Record<string, unknown>[];
    const first = rows[0]!;
    const cols = Object.keys(first);
    console.log(cols.join("\t"));
    for (const r of rows) console.log(cols.map((c) => String(r[c] ?? "")).join("\t"));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

// Positional args after the verb, excluding any --flag tokens and their values.
function positionalAfterVerb(): string[] {
  const rest = args.slice(1);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      if (!a.includes("=")) i++; // skip value
      continue;
    }
    out.push(a);
  }
  return out;
}

switch (cmd) {
  case "init": {
    const db = open(getFlag("db"));
    const ran = migrate(db);
    out({ applied: ran });
    break;
  }

  case "create": {
    // Flag-only. No positional args allowed.
    const input: CreateInput = {
      title: getFlag("title"),
      kind: getFlag("kind"),
      type: getFlag("type"),
      body: getFlag("body"),
      acceptance: getFlag("acceptance"),
      parent: getFlag("parent"),
      blockedBy: getFlag("blocked-by"),
      project: getFlag("project"),
    };
    const errs = validateCreate(input, positionalAfterVerb());
    if (errs.length > 0) {
      die(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));
    }
    const project = input.project ?? "arc-agents";
    const kind = input.kind!;
    const type = input.type!;
    const title = input.title!;
    const body = input.body ?? "";
    const acceptance = input.acceptance ?? "";
    const parent = input.parent ?? null;
    const blockedBy = input.blockedBy ?? null;
    const state = blockedBy ? "blocked" : "ready";
    const thread = getFlag("thread") ?? null;
    const sourceModule = getFlag("source-module") ?? null;

    const db = openWithMigrate(getFlag("db"));
    const id = mintId(db, title);
    db.run(
      `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by, thread_id, source_module)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, project, parent, title, body, acceptance, type, state, kind, blockedBy, thread, sourceModule],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`,
      [id, getFlag("agent") ?? "cli", title],
    );
    out({ id, state, thread_id: thread });
    break;
  }

  case "claim": {
    // ledger claim <worker> [--type X]
    // --type restricts the claim to a single priority class (used by fast-pass
    // interactive pool so a reserved slot doesn't burn on backlog work).
    const worker = args[1] ?? die("worker required");
    if (worker.startsWith("--")) die("worker required (positional)");
    const typeFilter = getFlag("type");
    const db = openWithMigrate(getFlag("db"));
    const typeClause = typeFilter ? "AND type=?2" : "";
    const sql = `UPDATE issues SET state='claimed', claimed_by=?1, claimed_at=strftime('%s','now')
         WHERE id=(SELECT id FROM issues WHERE state='ready' AND kind='task' ${typeClause} ORDER BY ${TYPE_PRIORITY_SQL}, id LIMIT 1)
         RETURNING id`;
    const row = typeFilter
      ? db.query<{ id: string }, [string, string]>(sql).get(worker, typeFilter)
      : db.query<{ id: string }, [string]>(sql).get(worker);
    if (!row) {
      out({ claimed: null });
      break;
    }
    db.run(`INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'claimed', ?, ?)`, [
      row.id,
      worker,
      `claimed by ${worker}`,
    ]);
    out({ claimed: row.id });
    break;
  }

  case "decompose": {
    // ledger decompose <parent-id> --child "t1" --child "t2" ...
    // Atomic: insert N HITL children, set parent.blocked_by=[ids], parent.state='blocked'.
    const parent = args[1];
    if (!parent || parent.startsWith("--")) die("parent id required (positional)");
    const children: string[] = [];
    for (let i = 2; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--child") {
        const v = args[++i];
        if (v !== undefined) children.push(v);
      } else if (a.startsWith("--child=")) {
        children.push(a.slice("--child=".length));
      }
    }
    const errs = validateDecompose({ parent, children });
    if (errs.length > 0) die(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));

    const db = openWithMigrate(getFlag("db"));
    const parentRow = db.query<{ id: string; project: string; state: string }, [string]>(
      "SELECT id, project, state FROM issues WHERE id=?",
    ).get(parent);
    if (!parentRow) die(`no such issue: ${parent}`);
    if (parentRow.state === "merged" || parentRow.state === "cancelled") {
      die(`cannot decompose from terminal state '${parentRow.state}'`);
    }
    const agent = getFlag("agent") ?? "bookie";
    const created: { id: string; title: string }[] = [];
    db.exec("BEGIN");
    try {
      for (const title of children) {
        const id = mintId(db, title);
        db.run(
          `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, state, kind, blocked_by)
           VALUES (?, ?, ?, ?, '', '', 'HITL', 'ready', 'task', NULL)`,
          [id, parentRow.project, parent, title],
        );
        db.run(
          `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`,
          [id, agent, `decomposed from ${parent}: ${title}`],
        );
        created.push({ id, title });
      }
      const blockedBy = JSON.stringify(created.map((c) => c.id));
      db.run(
        `UPDATE issues SET state='blocked', blocked_by=?, updated_at=strftime('%s','now') WHERE id=?`,
        [blockedBy, parent],
      );
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'progress', ?, ?)`,
        [parent, agent, `decomposed into ${created.length} children: ${created.map((c) => c.id).join(", ")}`],
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    out({ parent, children: created });
    break;
  }

  case "update": {
    const id = args[1] ?? die("id required");
    const state = getFlag("state");
    const evidence = getFlag("evidence");
    const pr = getFlag("pr");
    const branch = getFlag("branch");
    const worktree = getFlag("worktree");
    const hitl = getFlag("hitl");
    const db = openWithMigrate(getFlag("db"));

    if (state) {
      const cur = db.query<{ state: string }, [string]>("SELECT state FROM issues WHERE id=?").get(id);
      if (!cur) die(`no such issue: ${id}`);
      const errs = validateStateTransition(cur.state as never, state as never);
      if (errs.length > 0) die(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));
    }

    const sets: string[] = ["updated_at=strftime('%s','now')"];
    const vals: (string | number)[] = [];
    if (state) {
      sets.push("state=?");
      vals.push(state);
    }
    if (evidence) {
      sets.push("evidence_md=?");
      vals.push(evidence);
    }
    if (pr) {
      sets.push("pr_url=?");
      vals.push(pr);
    }
    if (branch) {
      sets.push("branch=?");
      vals.push(branch);
    }
    if (worktree) {
      sets.push("worktree_path=?");
      vals.push(worktree);
    }
    if (hitl !== undefined) {
      if (hitl !== "0" && hitl !== "1") die("--hitl must be 0 or 1");
      sets.push("hitl=?");
      vals.push(Number(hitl));
    }
    vals.push(id);
    db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id=?`, vals);
    if (state) {
      db.run(
        `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, ?, ?)`,
        [id, state === "merged" ? "merged" : state === "failed" ? "failed" : "progress", getFlag("agent") ?? "cli", `→ ${state}`],
      );
    }
    out({ id, updated: true });
    break;
  }

  case "event": {
    const id = args[1] ?? die("id required");
    const kind = args[2] ?? die("kind required");
    const payload = args[3] ?? "";
    const db = openWithMigrate(getFlag("db"));
    db.run(`INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, ?, ?, ?)`, [
      id,
      kind,
      getFlag("agent") ?? "cli",
      payload,
    ]);
    out({ id, kind, logged: true });
    break;
  }

  case "list": {
    const state = getFlag("state");
    const kind = getFlag("kind");
    const type = getFlag("type");
    const limit = parseInt(getFlag("limit") ?? "100", 10);
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (state) {
      where.push("state=?");
      vals.push(state);
    }
    if (kind) {
      where.push("kind=?");
      vals.push(kind);
    }
    if (type) {
      where.push("type=?");
      vals.push(type);
    }
    const sql = `SELECT id, state, kind, type, title FROM issues ${
      where.length ? "WHERE " + where.join(" AND ") : ""
    } ORDER BY ${TYPE_PRIORITY_SQL}, id LIMIT ?`;
    vals.push(limit);
    const db = openWithMigrate(getFlag("db"));
    out(db.query(sql).all(...vals));
    break;
  }

  case "show": {
    const id = args[1] ?? die("id required");
    const db = openWithMigrate(getFlag("db"));
    const issue = db.query("SELECT * FROM issues WHERE id=?").get(id);
    if (!issue) die(`no such issue: ${id}`);
    const events = db.query("SELECT seq, ts, agent, kind, payload_md FROM issue_events WHERE issue_id=? ORDER BY seq").all(id);
    out({ issue, events });
    break;
  }

  case "hitl": {
    // hitl emit --class taste|impact --kind ask_choice|ask_text|ask_confirm|notify|show_artifact
    //          --prompt "<q>" [--option X --option Y ...] [--recommended <idx-or-string>]
    //          [--timeout-sec N] [--divergence forward_fix|replay]
    //          [--anchor-repo R --anchor-branch B --anchor-commit C]
    //          [--emitted-by <id>] [--agent bookie]
    // Inserts hitl_prompts row + fans out hitl_deliveries to alive modules
    // implementing this kind. Returns { id, deliveries }. MVP for taste-class
    // optimistic execution: worker emits, surfaces to user, proceeds with
    // recommended; reconciliation handled separately.
    const sub = args[1];
    if (sub !== "emit") die("usage: hitl emit ...");
    const cls = getFlag("class") ?? die("--class taste|impact required");
    if (cls !== "taste" && cls !== "impact") die("--class must be taste|impact");
    const kind = getFlag("kind") ?? die("--kind required");
    const promptText = getFlag("prompt") ?? die("--prompt required");
    const recommended = getFlag("recommended");
    const timeoutSec = getFlag("timeout-sec");
    const divergence = getFlag("divergence");
    const anchorRepo = getFlag("anchor-repo");
    const anchorBranch = getFlag("anchor-branch");
    const anchorCommit = getFlag("anchor-commit");
    const emittedBy = getFlag("emitted-by") ?? getFlag("agent") ?? "bookie";

    if (cls === "taste" && recommended === undefined)
      die("--recommended required for class=taste");
    if (cls === "impact" && timeoutSec !== undefined)
      die("--timeout-sec forbidden for class=impact");
    if (divergence && divergence !== "forward_fix" && divergence !== "replay")
      die("--divergence must be forward_fix|replay");

    // Repeatable --option flag → options[] for ask_choice.
    const options: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--option") {
        const v = args[i + 1];
        if (v !== undefined) options.push(v);
      } else if (args[i]?.startsWith("--option=")) {
        options.push(args[i]!.slice("--option=".length));
      }
    }

    let payload: Record<string, unknown>;
    if (kind === "ask_choice") {
      if (options.length < 2) die("ask_choice requires at least 2 --option flags");
      payload = { prompt: promptText, options, artifacts: [] };
    } else if (kind === "ask_text" || kind === "ask_confirm") {
      payload = { prompt: promptText, artifacts: [] };
    } else if (kind === "notify") {
      payload = { message: promptText, level: "info" };
    } else {
      die(`--kind '${kind}' not supported by this verb (use ask_choice|ask_text|ask_confirm|notify)`);
    }

    const db = openWithMigrate(getFlag("db"));
    const cfg = loadConfig();
    const modules = pickModulesForHitl(db, cfg, kind as HitlKind);
    if (modules.length === 0)
      die(`no alive UX module implements '${kind}' — install/revive one (ADR 0002)`);

    const id = `hitl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    db.run(
      `INSERT INTO hitl_prompts
         (id, kind, class, payload, recommended, divergence_strategy, timeout_sec,
          anchor_repo, anchor_branch, anchor_commit, emitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        kind,
        cls,
        JSON.stringify(payload),
        recommended ?? null,
        divergence ?? null,
        timeoutSec ? parseInt(timeoutSec, 10) : null,
        anchorRepo ?? null,
        anchorBranch ?? null,
        anchorCommit ?? null,
        emittedBy,
      ],
    );
    const deliveries: string[] = [];
    for (const m of modules) {
      db.run(
        `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES (?, ?, 'pending')`,
        [id, m.name],
      );
      deliveries.push(m.name);
    }
    out({ id, kind, class: cls, recommended: recommended ?? null, deliveries });
    break;
  }

  case "tick": {
    // Backstop sweep: cascade-unblock + reclaim stale claims (>2hr).
    const db = openWithMigrate(getFlag("db"));
    const u = db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state != 'merged'
        )
    `);
    const s = sweepStaleClaims(db);
    out({ unblocked: u.changes, reclaimed: s.reset, reclaimed_ids: s.ids });
    break;
  }

  case "spawn-ready": {
    const type = getFlag("type");
    const db = openWithMigrate(getFlag("db"));
    const sql = `SELECT id, kind, type, title FROM issues WHERE state='ready' AND kind='task' ${
      type ? "AND type=?" : ""
    } ORDER BY ${TYPE_PRIORITY_SQL}, id`;
    out(type ? db.query(sql).all(type) : db.query(sql).all());
    break;
  }

  case "render-prompt": {
    // Emit the rendered worker system prompt for <id>. Pure read; no side effects.
    // worker-shell.sh shells out to this after claim so prompt logic lives in TS.
    const id = args[1] ?? die("id required");
    const worker = getFlag("worker") ?? "unknown";
    const db = openWithMigrate(getFlag("db"));
    const row = db
      .query<{ kind: string; type: string; thread_id: string | null }, [string]>(
        `SELECT kind, type, thread_id FROM issues WHERE id=?`,
      )
      .get(id);
    if (!row) die(`no issue ${id}`);
    // Thread replay: for chat_in tasks, include prior chat turns so the cold
    // interviewer has conversational continuity. Order = id (mintId is time-monotonic).
    let thread_history: { id: string; kind: string; title: string; body: string }[] | undefined;
    if (row.thread_id) {
      thread_history = db
        .query<{ id: string; kind: string; title: string; body: string }, [string, string]>(
          `SELECT id, kind, title, COALESCE(body_md, '') AS body
           FROM issues
           WHERE thread_id=? AND id != ? AND kind IN ('event','reply') AND source_module='arc-chat'
           ORDER BY id`,
        )
        .all(row.thread_id, id);
    }
    process.stdout.write(
      renderSystemPrompt({
        kind: row.kind,
        type: row.type,
        worker,
        task: id,
        thread_id: row.thread_id ?? undefined,
        thread_history,
      }),
    );
    break;
  }

  case "compact": {
    const db = openWithMigrate(getFlag("db"));
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const r = db.run(
      `DELETE FROM issues WHERE state IN ('merged','cancelled') AND updated_at < ?`,
      [cutoff],
    );
    out({ archived: r.changes });
    break;
  }

  case "vacuum": {
    const db = openWithMigrate(getFlag("db"));
    db.exec("VACUUM");
    out({ vacuumed: true });
    break;
  }

  case undefined:
  case "-h":
  case "--help":
  case "help": {
    console.log(`ledger <verb> [args]

  init                                 run migrations
  create --kind --type --title [...]   insert row (flag-only)
                                       flags: --project --body --acceptance --parent --blocked-by --agent
  claim <worker> [--type T]            atomic claim of highest-priority ready task
                                       (--type restricts to one priority class)
  decompose <parent> --child T [...]   atomic: create N HITL children, parent → blocked
  update <id> [--state --evidence --pr --branch --worktree --hitl 0|1 --agent]
  event <id> <kind> <payload>          append event row
  hitl emit --class taste|impact --kind <K> --prompt <q> [--option ...]
            [--recommended X --timeout-sec N --divergence forward_fix|replay]
                                       emit HITL prompt + fanout to alive UX modules
  list [--state --kind --type --limit]
  show <id>
  tick                                 cascade-unblock + reclaim stale (>2hr) claims
  spawn-ready [--type]                 emit JSON for ready rows
  render-prompt <id> [--worker W]      render worker system prompt for issue
  compact                              archive merged/cancelled > 30d
  vacuum

  global flags: --db <path>

NOTE: agents must route all WRITES (create, update, decompose, event) through
the bookie subagent. Direct CLI writes are reserved for bootstrap (worker-shell
claim) and human operators. Reads (list, show, spawn-ready) are unrestricted.`);
    break;
  }

  default:
    die(`unknown verb: ${cmd}`);
}

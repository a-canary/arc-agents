#!/usr/bin/env bun
// Ledger CLI. Verbs per PRD-v1 §4.
// JSON to stdout when not a TTY; table otherwise.

import { open, openWithMigrate, mintId } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";

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

switch (cmd) {
  case "init": {
    const db = open(getFlag("db"));
    const ran = migrate(db);
    out({ applied: ran });
    break;
  }

  case "create": {
    // ledger create <kind> <role> <title>
    const kind = args[1] ?? die("kind required");
    const role = args[2] ?? die("role required");
    const title = args[3] ?? die("title required");
    const project = getFlag("project") ?? "arc-agents";
    const type = getFlag("type") ?? "task";
    const body = getFlag("body") ?? "";
    const acceptance = getFlag("acceptance") ?? "";
    const parent = getFlag("parent") ?? null;
    const blockedBy = getFlag("blocked-by");
    const state = blockedBy ? "blocked" : "ready";

    const db = openWithMigrate(getFlag("db"));
    const id = mintId(db, title);
    db.run(
      `INSERT INTO issues (id, project, parent_id, title, body_md, acceptance_md, type, role, state, kind, blocked_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, project, parent, title, body, acceptance, type, role, state, kind, blockedBy ?? null],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'created', ?, ?)`,
      [id, getFlag("agent") ?? "cli", title],
    );
    out({ id, state });
    break;
  }

  case "claim": {
    // ledger claim <role> <worker>
    const role = args[1] ?? die("role required");
    const worker = args[2] ?? die("worker required");
    const db = openWithMigrate(getFlag("db"));
    const row = db
      .query<{ id: string }, [string, string]>(
        `UPDATE issues SET state='claimed', claimed_by=?2, claimed_at=strftime('%s','now')
         WHERE id=(SELECT id FROM issues WHERE state='ready' AND kind='task' AND role=?1 ORDER BY id LIMIT 1)
         RETURNING id`,
      )
      .get(role, worker);
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

  case "update": {
    const id = args[1] ?? die("id required");
    const state = getFlag("state");
    const evidence = getFlag("evidence");
    const pr = getFlag("pr");
    const branch = getFlag("branch");
    const worktree = getFlag("worktree");
    const db = openWithMigrate(getFlag("db"));
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
    const role = getFlag("role");
    const state = getFlag("state");
    const kind = getFlag("kind");
    const limit = parseInt(getFlag("limit") ?? "100", 10);
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (role) {
      where.push("role=?");
      vals.push(role);
    }
    if (state) {
      where.push("state=?");
      vals.push(state);
    }
    if (kind) {
      where.push("kind=?");
      vals.push(kind);
    }
    const sql = `SELECT id, state, kind, role, title FROM issues ${
      where.length ? "WHERE " + where.join(" AND ") : ""
    } ORDER BY id LIMIT ?`;
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

  case "tick": {
    // Backstop sweep: any blocked row whose blockers are all merged → ready.
    const db = openWithMigrate(getFlag("db"));
    const r = db.run(`
      UPDATE issues SET state='ready', updated_at=strftime('%s','now')
      WHERE state='blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(issues.blocked_by) dep
          JOIN issues b ON b.id = dep.value
          WHERE b.state != 'merged'
        )
    `);
    out({ unblocked: r.changes });
    break;
  }

  case "spawn-ready": {
    const role = getFlag("role");
    const db = openWithMigrate(getFlag("db"));
    const sql = `SELECT id, role, kind, title FROM issues WHERE state='ready' AND kind='task' ${
      role ? "AND role=?" : ""
    } ORDER BY id`;
    out(role ? db.query(sql).all(role) : db.query(sql).all());
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
  create <kind> <role> <title> [...]   insert row
                                       flags: --project --type --body --acceptance --parent --blocked-by --agent
  claim <role> <worker>                atomic claim of oldest ready task
  update <id> --state <s> [--evidence --pr --branch --worktree --agent]
  event <id> <kind> <payload>          append event row
  list [--role --state --kind --limit]
  show <id>
  tick                                 cascade-unblock sweep
  spawn-ready [--role]                 emit JSON for ready rows
  compact                              archive merged/cancelled > 30d
  vacuum

  global flags: --db <path>`);
    break;
  }

  default:
    die(`unknown verb: ${cmd}`);
}

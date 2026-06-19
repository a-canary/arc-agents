#!/usr/bin/env bun
// triage-chat — ADR 0010 triage worker.
//
// Reads pending chat lines (role=user, body non-empty, spawned=[]) from all
// arc-ux/chat/*.jsonl files in the chat root, decides grill-vs-delegate for
// each, creates the appropriate issues, and writes spawned ids back into the
// chat line.
//
// Decision logic (MVP):
//   grill_trigger_re = /\b(grill|review|discuss|question|talk|triage)\b/i
//   If body matches grill trigger → kind=sprint (grill session)
//   Otherwise                     → kind=task  (delegate)
//
//   Subsequent replies in an existing grill (detected by looking for a
//   non-terminal sibling sprint with the same blog_id in the chat file's slug)
//   are added as children of that sprint.
//
// Usage:
//   bun bin/triage-chat.ts                          # process all pending
//   bun bin/triage-chat.ts --dry-run               # show decisions without writing
//   bun bin/triage-chat.ts --slug <blog-id>        # process one blog post only
//   bun bin/triage-chat.ts --once                  # process each slug once then exit
//
// Environment:
//   ARC_CHAT_ROOT   default: ~/vault/arc-ux/chat
//   ARC_LEDGER_DB   default: ~/vault/ledger.db

import { open } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { pendingTriageLines, updateSpawned, type ChatLine } from "../src/ledger/chat";
import { mintId } from "../src/ledger/db";

const GRILL_RE = /\b(grill|review|discuss|question|talk|triage|explore|analyse|think)\b/i;
const DEFAULT_CHAT_ROOT =
  process.env.ARC_CHAT_ROOT ?? join(process.env.HOME ?? "/home/aaron", "vault", "arc-ux", "chat");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SLUG_FILTER = getFlag("slug");
const ONCE = args.includes("--once");

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1] ?? undefined;
}

function die(msg: string): never {
  console.error(`triage-chat: ${msg}`);
  process.exit(1);
}

// ─── Decision ────────────────────────────────────────────────────────────────

type Decision = { kind: "grill" | "delegate"; title: string; body_md: string };

function decide(line: ChatLine): Decision {
  const trimmed = line.body.trim();
  if (GRILL_RE.test(trimmed)) {
    return {
      kind: "grill",
      title: `Grill session: ${trimmed.slice(0, 60)}`,
      body_md: JSON.stringify({
        action: "grill_session",
        blog_id: line.blog_id,
        chat_file: join(DEFAULT_CHAT_ROOT, `${line.blog_id}.jsonl`),
        task_id: line.task_id,
        user_body: trimmed,
        triggered_by: "triage-worker (grill trigger match)",
      }),
    };
  }
  return {
    kind: "delegate",
    title: `Handle reply: ${trimmed.slice(0, 60)}`,
    body_md: JSON.stringify({
      action: "delegate",
      blog_id: line.blog_id,
      chat_file: join(DEFAULT_CHAT_ROOT, `${line.blog_id}.jsonl`),
      task_id: line.task_id,
      user_body: trimmed,
    }),
  };
}

// ─── Create issues ───────────────────────────────────────────────────────────

function findExistingGrill(db: ReturnType<typeof open>, blogId: string): string | null {
  // Look for a non-terminal sprint whose body references the same blog_id.
  const rows = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM issues
       WHERE kind = 'sprint'
         AND state NOT IN ('merged','cancelled','failed')
         AND body_md LIKE ?
       LIMIT 1`,
    )
    .all(`%"blog_id":"${blogId}"%`);
  return rows[0]?.id ?? null;
}

interface SpawnResult {
  issue_id: string;
  kind: "grill" | "delegate";
  parent_sprint_id?: string;
}

function spawnIssues(line: ChatLine, decision: Decision, db: ReturnType<typeof open>): SpawnResult[] {
  const results: SpawnResult[] = [];

  if (decision.kind === "grill") {
    const id = mintId(db, decision.title);
    db.run(
      `INSERT INTO issues
         (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, source_module)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "arc-agents",
        decision.title,
        decision.body_md,
        "Grill session completed. Document findings in evidence_md.",
        "mvp",
        "ready",
        "sprint",
        "mvp",
        "build",
        "triage",
        "triage-chat",
      ],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, agent, kind, payload_md)
       VALUES (?, 'triage-chat', 'created', ?)`,
      [id, `Grill session triaged from chat reply to ${line.blog_id}`],
    );
    results.push({ issue_id: id, kind: "grill" });
  } else {
    // delegate: check for existing grill
    const parentSprintId = findExistingGrill(db, line.blog_id);
    const id = mintId(db, decision.title);

    let blockedBy: string | null = null;
    if (parentSprintId) {
      blockedBy = JSON.stringify([parentSprintId]);
    }

    db.run(
      `INSERT INTO issues
         (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, source_module, blocked_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "arc-agents",
        decision.title,
        decision.body_md,
        "Task completed.",
        "mvp",
        "ready",
        "task",
        "mvp",
        "build",
        "triage",
        "triage-chat",
        blockedBy,
      ],
    );
    db.run(
      `INSERT INTO issue_events (issue_id, agent, kind, payload_md)
       VALUES (?, 'triage-chat', 'created', ?)`,
      [id, `Task delegated from chat reply to ${line.blog_id}${parentSprintId ? ` (child of sprint ${parentSprintId})` : ""}`],
    );
    results.push({ issue_id: id, kind: "delegate", parent_sprint_id: parentSprintId ?? undefined });
  }

  return results;
}

// ─── Slug discovery ─────────────────────────────────────────────────────────

function allSlugs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const db = open();
  migrate(db);

  const slugs = SLUG_FILTER
    ? [SLUG_FILTER]
    : allSlugs(DEFAULT_CHAT_ROOT);

  let processed = 0;
  let triaged = 0;

  for (const slug of slugs) {
    const lines = pendingTriageLines(slug, DEFAULT_CHAT_ROOT);
    for (const line of lines) {
      processed++;
      const decision = decide(line);
      console.error(`[triage] ${slug}/${line.task_id}: ${decision.kind} — "${decision.title.slice(0, 60)}"`);

      if (DRY_RUN) {
        console.log(JSON.stringify({ slug, task_id: line.task_id, decision, dry_run: true }));
        continue;
      }

      const spawned = spawnIssues(line, decision, db);
      const spawnedIds = spawned.map((s) => s.issue_id);

      updateSpawned(slug, line.task_id, spawnedIds, DEFAULT_CHAT_ROOT);
      triaged++;

      console.log(
        JSON.stringify({ slug, task_id: line.task_id, decision: decision.kind, spawned: spawnedIds }),
      );

      if (ONCE) {
        db.close();
        return;
      }
    }
  }

  db.close();
  console.error(`[triage] done. processed=${processed} triaged=${triaged}`);
}

if (import.meta.main) main();

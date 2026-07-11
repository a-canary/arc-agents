#!/usr/bin/env bun
// gate-triage — opus guardrails the approval queue so the human doesn't have to.
//
// For every review-state PRD: an opus judge classifies it as
//   human  — objective/scope/spend delta → stays in review, stamped
//            "HUMAN GATE: <reason>" (this is the ONLY thing Aaron approves)
//   auto   — operational work within existing objectives → opus approves it via
//            the SAME webui POST /approvals/:id/approve path a human click uses,
//            after stamping a per-task allowed-tools list + a risky-move
//            escalation rule into the body (render-prompt carries the body to
//            the worker, so the policy reaches the model that does the work).
//
// Idempotent: a PRD whose body already carries the gate-triage stamp is skipped.
// Fail-safe: opus unavailable / unparseable → row untouched (stays human-gated
// by default in review). ponytail: no schema change — the stamp lives in body_md.

import { Database } from "bun:sqlite";
import { spawnSync } from "bun";

const DB = process.env.LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`;
const WEBUI = process.env.WEBUI_URL ?? "http://localhost:8080";
const STAMP = "<!-- gate-triage -->";
const MODEL = process.env.GATE_MODEL ?? "opus";
// prds always; tasks only when orphaned in review >48h (fresh review tasks belong to worker-reviewer flow)
// A review-orphaned task whose worker run already left commits on its branch (reconcile logs
// "N commit(s)") — re-queueing it churns a worker claim; it needs merge review instead.
export function hasSalvageableCommits(db: Database, issueId: string): boolean {
  const row = db
    .query(
      "select 1 from issue_events where issue_id = ? and kind = 'progress' and payload_md like '%commit(s)%' limit 1",
    )
    .get(issueId);
  return row !== null;
}

export const SELECT_SQL =
  "select id, title, kind, coalesce(body_md,'') body from issues where state='review' and (kind='prd' or (kind='task' and updated_at < unixepoch('now')-172800)) and coalesce(body_md,'') not like '%' || ? || '%' order by rowid";

const ESCALATION = `Risky moves (delete/overwrite beyond your worktree, force-push, prod deploy/restart, docker outside your own stack, spend, secrets, cron/systemd edits) — STOP and dispatch a Task subagent (model: opus) to adjudicate with the exact command and blast radius; proceed only on an explicit APPROVE, else park the task with the denial as evidence.`;

type Verdict = { gate: "human" | "auto"; reason: string; allowed_tools: string[] };

export function parseVerdict(out: string): Verdict | null {
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (v.gate !== "human" && v.gate !== "auto") return null;
    if (typeof v.reason !== "string" || !v.reason) return null;
    if (!Array.isArray(v.allowed_tools)) return null;
    return { gate: v.gate, reason: v.reason.slice(0, 400), allowed_tools: v.allowed_tools.filter((t: unknown) => typeof t === "string").slice(0, 30) };
  } catch { return null; }
}

export function stamp(v: Verdict): string {
  if (v.gate === "human")
    return `\n\n---\n${STAMP}\n> **HUMAN GATE** (opus): ${v.reason}\n`;
  return `\n\n---\n${STAMP}\n> **auto-approved** (opus): ${v.reason}\n>\n> allowed-tools: ${v.allowed_tools.join(", ")}\n>\n> ${ESCALATION}\n`;
}

function judge(title: string, body: string): Verdict | null {
  const prompt = `You are the approval gatekeeper for an autonomous agent estate. The human owner only decides Objective/scope/spend deltas — everything operational is guardrailed by YOU, not him.

Classify this PRD:
- gate "human": it changes a mission objective/target, redefines scope, spends money, touches secrets/keys/accounts, or is irreversible beyond git (data deletion, external publishing, account changes).
- gate "auto": operational/engineering work inside existing objectives (code, tests, crons, hygiene, monitoring, refactors) — even large ones.

Also emit allowed_tools: the MINIMAL Claude Code tool list the implementing worker needs (from: Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch, Task). Bash only if it must run commands; WebFetch/WebSearch only if it needs the network.

PRD title: ${title}
PRD body:
${body.slice(0, 6000)}

Reply with ONLY JSON: {"gate":"human"|"auto","reason":"<one sentence>","allowed_tools":["..."]}`;
  const claude = Bun.which("claude") ?? "claude";
  const r = spawnSync([claude, "-p", "--model", MODEL, "--allowedTools", ""], { stdin: new TextEncoder().encode(prompt), timeout: 180_000 });
  if (r.exitCode !== 0) return null;
  return parseVerdict(new TextDecoder().decode(r.stdout));
}

if (import.meta.main) {
  const db = new Database(DB);
  const rows = db.query(SELECT_SQL).all(STAMP) as Array<{ id: string; title: string; kind: string; body: string }>;
  let human = 0, auto = 0, skipped = 0;
  for (const r of rows) {
    const v = judge(r.title, r.body);
    if (!v) { skipped++; console.log(`skip (no verdict): ${r.id}`); continue; }
    db.query("update issues set body_md = body_md || ? where id = ?").run(stamp(v), r.id);
    if (v.gate === "human") { human++; console.log(`HUMAN GATE: ${r.id} — ${v.reason}`); continue; }
    if (r.kind === "task") {
      // Orphaned task that already produced commits (worker branch salvageable): re-running a
      // worker just bounces it back to review — it needs a MERGE REVIEW, not re-execution.
      // Surface it as a webui-visible feedback row and leave it in review.
      if (hasSalvageableCommits(db, r.id)) {
        db.query(
          "insert or ignore into feedback (id, project, source, submitter, state, body_md, created_at) values (?, ?, 'gate-triage', 'gate-triage', 'OPEN', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        ).run(
          `gt-merge-review-${r.id.slice(0, 24)}`,
          "allmissions",
          `**needs merge review** — task \`${r.id}\` orphaned in review >48h with commits already on its worker branch. Re-execution would churn; review + merge (or close) the existing work instead.`,
        );
        console.log(`needs merge review: ${r.id} — salvageable commits, feedback row filed`);
        continue;
      }
      // webui approve route is prd-only (serve.ts "not a prd" 400) — re-queue orphaned task directly
      db.query("update issues set body_md = body_md || ?, state='ready' where id = ? and state='review'")
        .run("\n> re-queued by gate-triage after >48h orphaned in review. Worker: verify the premise against the live repo FIRST — the work may already be shipped or stale; if so, close with a reason instead of executing.\n", r.id);
      auto++; console.log(`auto-requeued task: ${r.id} — ${v.reason}`);
      continue;
    }
    const resp = await fetch(`${WEBUI}/approvals/${encodeURIComponent(r.id)}/approve`, { method: "POST" });
    if (resp.ok || resp.status === 303) { auto++; console.log(`auto-approved: ${r.id} — ${v.reason}`); }
    else console.log(`approve POST failed (${resp.status}): ${r.id} — left in review`);
  }
  console.log(`gate-triage: ${rows.length} reviewed → ${human} human-gated, ${auto} auto-approved, ${skipped} skipped`);
}

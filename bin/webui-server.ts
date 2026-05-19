#!/usr/bin/env bun
// S2: arc-webui SSE ledger-delta server.
// Binds tailscale0 (fail-fast if missing). Polls ledger 1s. Emits SSE
// deltas on /sse/hitl and /sse/afk. See SLICE-PLAN-arc-webui.md.

import { networkInterfaces } from "node:os";
import { open } from "../src/ledger/db";
import type { Database } from "bun:sqlite";

const IFACE = process.env.ARC_WEBUI_IFACE ?? "tailscale0";
const PORT = Number(process.env.ARC_WEBUI_PORT ?? 8088);
const POLL_MS = Number(process.env.ARC_WEBUI_POLL_MS ?? 1000);
const COMPLETED_LIMIT = 10;

export function resolveIfaceAddr(iface: string): string {
  const nets = networkInterfaces();
  const addrs = nets[iface];
  if (!addrs || addrs.length === 0) {
    throw new Error(`interface ${iface} not found (set ARC_WEBUI_IFACE to override)`);
  }
  const v4 = addrs.find((a) => a.family === "IPv4" && !a.internal);
  if (v4) return v4.address;
  const v6 = addrs.find((a) => a.family === "IPv6" && !a.internal);
  if (v6) return v6.address;
  throw new Error(`interface ${iface} has no non-internal address`);
}

type IssueRow = {
  id: string;
  project: string | null;
  parent_id: string | null;
  title: string;
  type: string;
  state: string;
  kind: string;
  class: string;
  urgency: string;
  hitl: number;
  priority: number | null;
  paused: number;
  deferred_at: number | null;
  artifact_dir: string | null;
  draft_md: string | null;
  pr_url: string | null;
  thread_id: string | null;
  blocked_by: string | null;
  updated_at: number;
};

export function queryHitlRows(db: Database): IssueRow[] {
  // HITL panel: rows the human needs to act on. HITL-type rows in non-terminal
  // states, plus blocked parents waiting on HITL children.
  return db
    .query<IssueRow, []>(
      `SELECT id, project, parent_id, title, type, state, kind, class, urgency,
              hitl, priority, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at
         FROM issues
        WHERE (type = 'HITL' OR hitl = 1)
          AND state NOT IN ('merged','cancelled','failed')
        ORDER BY COALESCE(priority, 999) ASC, updated_at DESC`,
    )
    .all();
}

export function queryAfkRows(db: Database): IssueRow[] {
  // AFK DAG window: in-flight (claimed/wip/review) + blocked + ready + last
  // COMPLETED_LIMIT merged. See SLICE-PLAN dag window rule.
  const inflight = db
    .query<IssueRow, []>(
      `SELECT id, project, parent_id, title, type, state, kind, class, urgency,
              hitl, priority, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at
         FROM issues
        WHERE state IN ('claimed','wip','review','blocked','ready')
          AND paused = 0
        ORDER BY COALESCE(priority, 999) ASC, updated_at DESC`,
    )
    .all();
  const recent = db
    .query<IssueRow, [number]>(
      `SELECT id, project, parent_id, title, type, state, kind, class, urgency,
              hitl, priority, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at
         FROM issues
        WHERE state = 'merged'
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(COMPLETED_LIMIT);
  return [...inflight, ...recent];
}

type IssueEvent = {
  seq: number;
  issue_id: string;
  ts: number;
  agent: string;
  kind: string;
  payload_md: string | null;
};

export type ThreadView = {
  issue: IssueRow;
  events: IssueEvent[];
  related: IssueRow[];
};

const ISSUE_COLS = `id, project, parent_id, title, type, state, kind, class, urgency,
              hitl, priority, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at`;

export function queryThread(db: Database, id: string): ThreadView | null {
  const issue = db
    .query<IssueRow, [string]>(`SELECT ${ISSUE_COLS} FROM issues WHERE id = ?`)
    .get(id);
  if (issue) {
    const events = db
      .query<IssueEvent, [string]>(
        `SELECT seq, issue_id, ts, agent, kind, payload_md
           FROM issue_events WHERE issue_id = ? ORDER BY seq ASC`,
      )
      .all(id);
    const related = issue.thread_id
      ? db
          .query<IssueRow, [string, string]>(
            `SELECT ${ISSUE_COLS} FROM issues WHERE thread_id = ? AND id != ? ORDER BY updated_at ASC`,
          )
          .all(issue.thread_id, id)
      : [];
    return { issue, events, related };
  }
  const rows = db
    .query<IssueRow, [string]>(
      `SELECT ${ISSUE_COLS} FROM issues WHERE thread_id = ? ORDER BY updated_at ASC`,
    )
    .all(id);
  if (rows.length === 0) return null;
  const anchor = rows[0]!;
  const events = db
    .query<IssueEvent, [string]>(
      `SELECT seq, issue_id, ts, agent, kind, payload_md
         FROM issue_events WHERE issue_id = ? ORDER BY seq ASC`,
    )
    .all(anchor.id);
  return { issue: anchor, events, related: rows.slice(1) };
}

function digest(rows: IssueRow[]): string {
  // Cheap fingerprint: id|state|updated_at per row. Caller compares strings.
  let h = "";
  for (const r of rows) h += `${r.id}|${r.state}|${r.updated_at};`;
  return h;
}

type Panel = "hitl" | "afk";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sseStream(db: Database, panel: Panel, pollMs = POLL_MS): ReadableStream<Uint8Array> {
  const fetchRows = panel === "hitl" ? queryHitlRows : queryAfkRows;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastDigest = "";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = () => {
        try {
          const rows = fetchRows(db);
          const d = digest(rows);
          if (d !== lastDigest) {
            lastDigest = d;
            controller.enqueue(encoder.encode(formatSseEvent("snapshot", { panel, rows })));
          } else {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          }
        } catch (e) {
          controller.enqueue(
            encoder.encode(formatSseEvent("error", { message: (e as Error).message })),
          );
        }
      };
      tick();
      timer = setInterval(tick, pollMs);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
}

export function buildHandler(db: Database) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, iface: IFACE }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/sse/hitl") {
      return new Response(sseStream(db, "hitl"), { headers: sseHeaders() });
    }
    if (url.pathname === "/sse/afk") {
      return new Response(sseStream(db, "afk"), { headers: sseHeaders() });
    }
    if (url.pathname.startsWith("/thread/")) {
      const id = decodeURIComponent(url.pathname.slice("/thread/".length));
      if (!id) return new Response("missing id", { status: 400 });
      const thread = queryThread(db, id);
      if (!thread) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(thread), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const addr = resolveIfaceAddr(IFACE);
  const db = open();
  const server = Bun.serve({
    hostname: addr,
    port: PORT,
    fetch: buildHandler(db),
  });
  console.log(`webui-server listening on http://${server.hostname}:${server.port} (iface=${IFACE})`);
}

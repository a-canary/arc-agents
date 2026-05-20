#!/usr/bin/env bun
// S2: arc-webui SSE ledger-delta server.
// S5: + /hitl static panel, /api/top3 + /api/submit endpoints.
// Binds tailscale0 (fail-fast if missing). Polls ledger 1s. Emits SSE
// deltas on /sse/hitl and /sse/afk. See SLICE-PLAN-arc-webui.md.

import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open, mintId } from "../src/ledger/db";
import type { Database } from "bun:sqlite";

const IFACE = process.env.ARC_WEBUI_IFACE ?? "tailscale0";
const PORT = Number(process.env.ARC_WEBUI_PORT ?? 8080);
const POLL_MS = Number(process.env.ARC_WEBUI_POLL_MS ?? 1000);
const COMPLETED_LIMIT = 10;
const TOP3_LIMIT = 3;
const ARTIFACTS_ROOT = process.env.ARC_WEBUI_ARTIFACTS
  ?? `${process.env.HOME}/vault/arc-webui/artifacts`;
const HITL_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "../assets/webui/hitl.html");

export function resolveIfaceAddr(iface: string): string {
  // Bun.serve accepts these literals directly — bypass interface lookup.
  if (iface === "0.0.0.0" || iface === "::") return iface;
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

export function queryTop3ChatIn(db: Database): IssueRow[] {
  // S5: top-3 chat_in rows (interviewer thread heads) by priority.
  // chat_in = kind=event, source_module=arc-chat, non-terminal state.
  return db
    .query<IssueRow, [number]>(
      `SELECT id, project, parent_id, title, type, state, kind, class, urgency,
              hitl, priority, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at
         FROM issues
        WHERE kind = 'event'
          AND source_module = 'arc-chat'
          AND state NOT IN ('merged','cancelled','failed')
        ORDER BY COALESCE(priority, 999) ASC, updated_at DESC
        LIMIT ?`,
    )
    .all(TOP3_LIMIT);
}

export type SubmitInput = {
  thread_id: string;
  body: string;
  in_reply_to?: string;
};

export function submitReply(db: Database, input: SubmitInput): { id: string } {
  // S5: write chat_out reply row. Mirrors arc-chat tail filter:
  // WHERE thread_id=? AND kind='reply' AND source_module='arc-chat'.
  const body = input.body.trim();
  if (!body) throw new Error("body required");
  if (!input.thread_id) throw new Error("thread_id required");
  const title = body.length > 80 ? body.slice(0, 77) + "..." : body;
  const id = mintId(db, title);
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind,
                         class, urgency, source_module, thread_id, parent_id, hitl,
                         created_at, updated_at)
     VALUES (?, 'arc-agents', ?, ?, '', 'interactive', 'merged', 'reply',
             'class_unset', 'interactive', 'arc-chat', ?, ?, 0, ?, ?)`,
    [id, title, body, input.thread_id, input.in_reply_to ?? null, now, now],
  );
  db.run(
    `INSERT INTO issue_events (issue_id, ts, kind, agent, payload_md)
     VALUES (?, ?, 'note', 'arc-webui', ?)`,
    [id, now, `submit via /api/submit (thread=${input.thread_id})`],
  );
  return { id };
}

async function readAlternatives(rowId: string): Promise<unknown> {
  const path = join(ARTIFACTS_ROOT, rowId, "alternatives.json");
  if (!existsSync(path)) return { alternatives: [] };
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { alternatives: [] };
  }
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
  return async (req: Request): Promise<Response> => {
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
    if (url.pathname === "/hitl" || url.pathname === "/hitl/") {
      try {
        const html = await readFile(HITL_HTML_PATH, "utf8");
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      } catch {
        return new Response("hitl.html missing", { status: 500 });
      }
    }
    if (url.pathname === "/api/top3" && req.method === "GET") {
      const rows = queryTop3ChatIn(db);
      return new Response(JSON.stringify({ rows }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const altMatch = url.pathname.match(/^\/api\/alternatives\/([A-Za-z0-9_.-]+)$/);
    if (altMatch && req.method === "GET") {
      const data = await readAlternatives(altMatch[1]!);
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/api/submit" && req.method === "POST") {
      let payload: SubmitInput;
      try {
        payload = (await req.json()) as SubmitInput;
      } catch {
        return new Response(JSON.stringify({ error: "invalid json" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const { id } = submitReply(db, payload);
        return new Response(JSON.stringify({ ok: true, id }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
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

#!/usr/bin/env bun
// S2: arc-webui SSE ledger-delta server.
// Binds tailscale0 (fail-fast if missing). Polls ledger 1s. Emits SSE
// deltas on /sse/hitl and /sse/afk. See SLICE-PLAN-arc-webui.md.

import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export type ChatOutRunner = (args: {
  thread_id: string;
  body_md: string;
}) => { ok: true; id: string } | { ok: false; error: string };

export function defaultChatOutRunner(): ChatOutRunner {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const ledger = join(repo, "bin", "ledger.ts");
  return ({ thread_id, body_md }) => {
    const title = body_md.length > 80 ? body_md.slice(0, 77) + "..." : body_md;
    const dbFlag = process.env.ARC_LEDGER_DB ? ["--db", process.env.ARC_LEDGER_DB] : [];
    const r = spawnSync(
      "bun",
      [
        ledger, "create",
        "--kind", "reply",
        "--type", "interactive",
        "--source-module", "arc-chat",
        "--title", title,
        "--body", body_md,
        "--thread", thread_id,
        "--agent", "webui",
        ...dbFlag,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return { ok: false, error: r.stderr || `exit ${r.status}` };
    try {
      const parsed = JSON.parse(r.stdout) as { id: string };
      return { ok: true, id: parsed.id };
    } catch (e) {
      return { ok: false, error: `unparseable ledger output: ${(e as Error).message}` };
    }
  };
}

export async function handleChatOut(req: Request, runner: ChatOutRunner): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = parsed as { thread_id?: unknown; body_md?: unknown };
  const thread_id = typeof body.thread_id === "string" ? body.thread_id.trim() : "";
  const body_md = typeof body.body_md === "string" ? body.body_md : "";
  if (!thread_id || !body_md) {
    return new Response(
      JSON.stringify({ error: "thread_id and body_md required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const result = runner({ thread_id, body_md });
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ id: result.id, thread_id }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildHandler(db: Database, chatOutRunner?: ChatOutRunner) {
  const runner = chatOutRunner ?? defaultChatOutRunner();
  return (req: Request): Response | Promise<Response> => {
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
    if (url.pathname === "/chat-out" && req.method === "POST") {
      return handleChatOut(req, runner);
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

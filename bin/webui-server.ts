#!/usr/bin/env bun
// S2: arc-webui SSE ledger-delta server.
// Binds tailscale0 (fail-fast if missing). Polls ledger 1s. Emits SSE
// deltas on /sse/hitl and /sse/afk. See SLICE-PLAN-arc-webui.md.

import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/ledger/db";
import type { Database } from "bun:sqlite";

const IFACE = process.env.ARC_WEBUI_IFACE ?? "tailscale0";
const PORT = Number(process.env.ARC_WEBUI_PORT ?? 8088);
const POLL_MS = Number(process.env.ARC_WEBUI_POLL_MS ?? 1000);
const COMPLETED_LIMIT = 10;
// Path to the static HITL panel HTML, resolved relative to this script.
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
  // Migration 017: class→tier, urgency→pool; priority column dropped
  tier: string;
  pool: string;
  hitl: number;
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
  //
  // ADR 0002 Deliveries Module: arc-webui is a sync UX module (polls ledger directly,
  // no pusher daemon). This query is the primary data source for the HITL panel.
  // The panel renders via hitl_deliveries (one row per alive UX module, broadcast by
  // bookie on prompt insert). Individual delivery state is tracked per module;
  // queryHitlRows is the hitl_prompts-proxy for the webui module's render surface.
  return db
    .query<IssueRow, []>(
      `SELECT id, project, parent_id, title, type, state, kind, tier, pool,
              hitl, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at
         FROM issues
        WHERE (type = 'HITL' OR hitl = 1)
          AND state NOT IN ('merged','cancelled','failed')
        ORDER BY updated_at DESC`,
    )
    .all();
}

export function queryAfkRows(db: Database): IssueRow[] {
  // AFK DAG window: in-flight (claimed/wip/review) + blocked + ready + last
  // COMPLETED_LIMIT merged. See SLICE-PLAN dag window rule.
  const inflight = db
    .query<IssueRow, []>(
      `SELECT id, project, parent_id, title, type, state, kind, tier, pool,
              hitl, paused, deferred_at, artifact_dir, draft_md,
              pr_url, thread_id, blocked_by, updated_at
         FROM issues
        WHERE state IN ('claimed','wip','review','blocked','ready')
          AND paused = 0
        ORDER BY updated_at DESC`,
    )
    .all();
  const recent = db
    .query<IssueRow, [number]>(
      `SELECT id, project, parent_id, title, type, state, kind, tier, pool,
              hitl, paused, deferred_at, artifact_dir, draft_md,
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
    // HITL panel: static HTML page served from assets/webui/.
    if (url.pathname === "/hitl" || url.pathname === "/hitl/") {
      try {
        const html = readFileSync(HITL_HTML_PATH, "utf8");
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch {
        return new Response("assets/webui/hitl.html missing", { status: 500 });
      }
    }
    // HITL panel data endpoint: mirrors the SSE hitl projection as a plain JSON API.
    // ADR 0002 requires UX modules to render via hitl_deliveries rows; this endpoint
    // is the arc-webui module's read path into that projection. Status codes:
    //   200 – rows as {rows: IssueRow[]}
    // Note: individual delivery state (per-module delivered/retracted/acked) lives
    // in hitl_deliveries and is read by arc-webui as a sync module polling the ledger.
    if (url.pathname === "/api/hitl" && req.method === "GET") {
      const rows = queryHitlRows(db);
      return new Response(JSON.stringify({ rows }), {
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

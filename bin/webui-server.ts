#!/usr/bin/env bun
// S2: arc-webui SSE ledger-delta server.
// Binds tailscale0 (fail-fast if missing). Polls ledger 1s. Emits SSE
// deltas on /sse/hitl and /sse/afk. See SLICE-PLAN-arc-webui.md.

import { networkInterfaces } from "node:os";
import type { Dirent } from "node:fs";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { open } from "../src/ledger/db";
import type { Database } from "bun:sqlite";

const IFACE = process.env.ARC_WEBUI_IFACE ?? "tailscale0";
const PORT = Number(process.env.ARC_WEBUI_PORT ?? 8088);
const POLL_MS = Number(process.env.ARC_WEBUI_POLL_MS ?? 1000);
const COMPLETED_LIMIT = 10;

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

const ARTIFACT_LIST_CAP = 500;
const ARTIFACT_FILE_BYTE_CAP = 2 * 1024 * 1024;

export type ArtifactEntry = { path: string; size: number; mtime: number };

// Returns "missing" if row doesn't exist; "unset" if artifact_dir is null;
// otherwise the dir string. Callers distinguish to return 404 with a useful reason.
export type ArtifactDirLookup =
  | { kind: "missing" }
  | { kind: "unset" }
  | { kind: "ok"; dir: string };

export function getArtifactDir(db: Database, rowId: string): ArtifactDirLookup {
  const r = db
    .query<{ artifact_dir: string | null }, [string]>(
      `SELECT artifact_dir FROM issues WHERE id = ?`,
    )
    .get(rowId);
  if (!r) return { kind: "missing" };
  if (!r.artifact_dir) return { kind: "unset" };
  return { kind: "ok", dir: r.artifact_dir };
}

export function listArtifactFiles(dir: string, cap = ARTIFACT_LIST_CAP): ArtifactEntry[] {
  const root = resolve(dir);
  const out: ArtifactEntry[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < cap) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(cur, String(e.name));
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile()) {
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        out.push({
          path: relative(root, abs).split(sep).join("/"),
          size: st.size,
          mtime: Math.floor(st.mtimeMs / 1000),
        });
        if (out.length >= cap) break;
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function resolveArtifactFile(dir: string, relPath: string): string | null {
  // Reject traversal: resolved path must remain inside dir.
  if (!relPath || relPath.startsWith("/")) return null;
  const root = resolve(dir);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

export function buildHandler(db: Database) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, iface: IFACE }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    // ProgramBench-lite trend graph for the dashboard. Static SVG rendered by
    // program-bench/run.ts; served raw so the dashboard can <img src> it.
    if (url.pathname === "/program-bench" || url.pathname === "/program-bench.svg") {
      const svg = join(import.meta.dir, "..", "program-bench", "trend.svg");
      if (!existsSync(svg)) {
        return new Response("no program-bench run yet", { status: 404 });
      }
      return new Response(readFileSync(svg), {
        headers: { "Content-Type": "image/svg+xml" },
      });
    }
    if (url.pathname === "/sse/hitl") {
      return new Response(sseStream(db, "hitl"), { headers: sseHeaders() });
    }
    if (url.pathname === "/sse/afk") {
      return new Response(sseStream(db, "afk"), { headers: sseHeaders() });
    }
    // GET /artifacts/:row_id            -> file listing JSON
    // GET /artifacts/:row_id/file?path= -> single file contents
    const artMatch = url.pathname.match(/^\/artifacts\/([^/]+)(\/file)?$/);
    if (artMatch) {
      const rowId = decodeURIComponent(artMatch[1]!);
      const isFile = artMatch[2] === "/file";
      const look = getArtifactDir(db, rowId);
      if (look.kind === "missing") {
        return new Response(JSON.stringify({ error: "row not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (look.kind === "unset") {
        return new Response(JSON.stringify({ error: "no artifact_dir" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const dir = look.dir;
      if (!isFile) {
        const files = listArtifactFiles(dir);
        return new Response(
          JSON.stringify({ row_id: rowId, artifact_dir: dir, files, truncated: files.length >= ARTIFACT_LIST_CAP }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      const relPath = url.searchParams.get("path") ?? "";
      const abs = resolveArtifactFile(dir, relPath);
      if (!abs) {
        return new Response(JSON.stringify({ error: "invalid path" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        return new Response(JSON.stringify({ error: "file not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!st.isFile()) {
        return new Response(JSON.stringify({ error: "not a file" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (st.size > ARTIFACT_FILE_BYTE_CAP) {
        return new Response(JSON.stringify({ error: "file too large", size: st.size, cap: ARTIFACT_FILE_BYTE_CAP }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(Bun.file(abs));
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

// wake-core.ts — pure wake logic for the scoped-watch extension (DESIGN-wake.md).
// createWakeCore({readRequests, readRow, checkPid, spawnCmd, send}) → {tick(), setSession()}
// Every I/O touchpoint is injected so the whole decision layer is testable.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface WakeRequest {
  session: string;
  type: "row" | "pid" | "cmd" | string;
  id?: string;
  pid?: number;
  cmd?: string;
  label?: string;
  cwd?: string;
  states?: string[];
  startTime?: number;
  ts: number;
}

export interface WakeMessage {
  customType: string;
  content: string;
  display: boolean;
}

export interface RowState {
  id: string;
  state: string;
  blocked_by?: string | null;
  project?: string;
}

export interface SpawnResult {
  /** exit code; non-zero also used for spawn failure */
  code: number;
  /** log path, or the error string when the spawn itself failed */
  output: string;
}

export interface WakeCoreOptions {
  readRequests: () => string;
  readRow: (id: string) => RowState | null | undefined;
  /** true = original process still alive. startTime 0 = unknown (non-Linux). */
  checkPid: (pid: number, startTime: number) => boolean;
  spawnCmd: (cmd: string, cwd: string | undefined, key: string) => Promise<SpawnResult>;
  send: (wake: WakeMessage) => void;
  sessionStartTime?: number;
  onCorruptLine?: () => void;
}

const DEFAULT_STATES = ["merged", "failed", "cancelled", "blocked"];
const ICONS: Record<string, string> = {
  merged: "✅",
  failed: "❌",
  cancelled: "⚠️",
  blocked: "⚠️",
};

/** Process start time (/proc/<pid>/stat field 22), 0 when unreadable.
 *  ponytail: Linux-only; callers fall back to kill(pid,0) (PID-reuse blind). */
export function readProcStartTime(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // comm (field 2) can contain spaces and parens — fields resume after the LAST ')'.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(after[19]) || 0; // field 22 = index 19 counting from field 3
  } catch {
    return 0;
  }
}

export function cmdKey(cmd: string, cwd?: string): string {
  return createHash("sha1").update(`${cmd}::${cwd || ""}`).digest("hex");
}

export function createWakeCore(opts: WakeCoreOptions) {
  let currentSession: string | null = null;
  let sessionStartTime = opts.sessionStartTime ?? 0;

  // ponytail: full file re-read every tick. The design's offset cache breaks
  // when `wakeme gc` compacts the file; it is bounded to KB by the 7-day TTL.
  const seen = new Set<string>(); // consumed request keys: row:<id> | pid:<pid> | cmd:<sha1>
  const fired = new Set<string>(); // keys that already woke — watches are one-shot
  const rowStates = new Map<string, string>(); // row id → last observed state
  const inFlightCmds = new Set<string>();

  function checkRowWatch(req: WakeRequest): WakeMessage | null {
    if (!req.id) return null;
    const row = opts.readRow(req.id);
    if (!row) return null;

    const last = rowStates.get(req.id);
    if (row.state === last) return null;
    rowStates.set(req.id, row.state);

    // Armed watch with no prior observation fires immediately if the row is
    // already terminal — the row can flip between `wakeme row` and the next tick.
    const states = req.states || DEFAULT_STATES;
    if (!states.includes(row.state)) return null;

    const blocked = row.blocked_by ? ` (blocked by ${row.blocked_by})` : "";
    return {
      customType: "wake",
      content: `${ICONS[row.state] ?? "•"} ${req.id} → ${row.state}${blocked}`,
      display: true,
    };
  }

  function checkPidWatch(req: WakeRequest): WakeMessage | null {
    if (!req.pid || !req.label) return null;
    if (opts.checkPid(req.pid, req.startTime ?? 0)) return null;
    return {
      customType: "wake",
      content: `⚠️ pid ${req.pid} stopped (${req.label})`,
      display: true,
    };
  }

  async function runCmdWatch(req: WakeRequest, key: string): Promise<WakeMessage | null> {
    if (!req.cmd || !req.label) return null;
    if (inFlightCmds.has(key)) return null;
    inFlightCmds.add(key);
    let result: SpawnResult;
    try {
      result = await opts.spawnCmd(req.cmd, req.cwd, key);
    } catch (err) {
      result = { code: 1, output: String(err) };
    }
    inFlightCmds.delete(key);
    const where = result.output ? ` (${result.output})` : "";
    return {
      customType: "wake",
      content: `${result.code === 0 ? "✅" : "❌"} ${req.label} exit=${result.code}${where}`,
      display: true,
    };
  }

  async function tick() {
    if (!currentSession) return;

    const wakes: WakeMessage[] = [];
    const pending: Promise<WakeMessage | null>[] = [];

    for (const line of opts.readRequests().split("\n")) {
      if (!line.trim()) continue;

      let req: WakeRequest;
      try {
        req = JSON.parse(line);
      } catch {
        opts.onCorruptLine?.();
        continue;
      }
      if (req.session !== currentSession) continue;

      let key: string;
      if (req.type === "row" && req.id) key = `row:${req.id}`;
      else if (req.type === "pid" && req.pid) key = `pid:${req.pid}`;
      else if (req.type === "cmd" && req.cmd) key = `cmd:${cmdKey(req.cmd, req.cwd)}`;
      else continue; // unknown/incomplete type — forward-compatible skip

      if (fired.has(key)) continue; // one-shot: never re-wake for the same watch
      const firstSeen = !seen.has(key);
      seen.add(key);

      // Lines predating this session are consumed silently (anti-spam prime).
      // ponytail: applies to every type, so a cmd watch registered moments
      // before a pi crash is NOT re-run on resume — re-register after restart.
      // Upgrade: per-type priming if that bites.
      if (req.ts < sessionStartTime) {
        if (firstSeen && req.type === "row" && req.id) {
          const row = opts.readRow(req.id);
          if (row) rowStates.set(req.id, row.state);
        }
        continue;
      }

      if (req.type === "row" || req.type === "pid") {
        const wake = req.type === "row" ? checkRowWatch(req) : checkPidWatch(req);
        if (wake) {
          fired.add(key);
          wakes.push(wake);
        }
      } else if (req.type === "cmd" && firstSeen) {
        pending.push(runCmdWatch(req, key.slice(4)));
      }
    }

    for (const wake of await Promise.all(pending)) if (wake) wakes.push(wake);
    for (const wake of wakes) opts.send(wake);
  }

  return {
    tick,
    setSession(sessionId: string) {
      currentSession = sessionId;
      if (sessionStartTime === 0) sessionStartTime = Date.now();
    },
    getSession() {
      return currentSession;
    },
  };
}

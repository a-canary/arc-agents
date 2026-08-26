// ledger-wake.ts — pi extension glue for wake-core (DESIGN-wake.md).
// Polls ~/.pi/agent/wake-requests.jsonl every 15s and wakes THIS session only
// on watches it registered itself (`wakeme`). No global all-rows wake.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWakeCore, readProcStartTime } from "./wake-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUESTS_FILE = `${process.env.HOME}/.pi/agent/wake-requests.jsonl`;
export const LOG_DIR = `${process.env.HOME}/.pi/agent/wake-logs`;
const DB = `${process.env.HOME}/vault/ledger.db`;
const INTERVAL_MS = 15_000;

// pi runs on Node (node:sqlite), repo tooling runs on Bun (bun:sqlite) — load
// lazily so this file stays importable under bun test.
let DatabaseCtor: typeof import("node:sqlite").DatabaseSync | null = null;

/** Detached shell spawn; stdout+stderr → <logDir>/<key>.log. Resolves on exit.
 *  fd-based stdio (not stream objects): works under both Node and Bun. */
export function makeSpawnCmd(logDir: string) {
  return (cmd: string, cwd: string | undefined, key: string) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const log = join(logDir, `${key}.log`);
      let fd: number;
      try {
        mkdirSync(logDir, { recursive: true });
        fd = openSync(log, "a");
      } catch (err) {
        resolve({ code: 1, output: String(err) }); // spawn failure → immediate ❌ wake
        return;
      }
      const child = spawn(cmd, {
        shell: true,
        detached: true,
        cwd: cwd || process.env.HOME,
        stdio: ["ignore", fd, fd],
      });
      const done = (code: number | null, err?: Error) => {
        try {
          closeSync(fd);
        } catch {}
        resolve({ code: err ? 1 : code ?? 1, output: err ? String(err) : log });
      };
      child.on("exit", (code) => done(code));
      child.on("error", (err) => done(null, err));
    });
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;

  const core = createWakeCore({
    // missing file = silent no-op (non-arc session / nothing armed)
    readRequests: () => {
      try {
        return readFileSync(REQUESTS_FILE, "utf-8");
      } catch {
        return "";
      }
    },
    // ponytail: fresh readOnly connection per row per tick; bounded by the few
    // watches a session arms. Upgrade to a cached handle if that ever shows.
    readRow: (id) => {
      if (!DatabaseCtor) return null;
      let db: InstanceType<typeof DatabaseCtor>;
      try {
        db = new DatabaseCtor(DB, { readOnly: true });
      } catch {
        return null; // no ledger.db on this machine — row watches are inert
      }
      try {
        return db.prepare("select id, state, blocked_by from issues where id = ?").get(id) as
          | { id: string; state: string; blocked_by?: string | null }
          | undefined;
      } catch {
        return null;
      } finally {
        db.close();
      }
    },
    checkPid: (pid, startTime) => {
      const current = readProcStartTime(pid);
      if (current) return startTime ? current === startTime : true; // start-time match = same process
      try {
        process.kill(pid, 0); // ponytail: non-Linux fallback, PID-reuse blind
        return true;
      } catch {
        return false;
      }
    },
    // ponytail: in-flight cmd watches die with the pi process; re-register after
    // restart. Upgrade: persist in-flight state if this bites.
    spawnCmd: makeSpawnCmd(LOG_DIR),
    send: (wake) => pi.sendMessage(wake, { triggerTurn: true, deliverAs: "followUp" }),
  });

  const tick = async () => {
    try {
      await core.tick();
    } catch (err) {
      console.error("ledger-wake tick failed:", err);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      ({ DatabaseSync: DatabaseCtor } = await import("node:sqlite"));
    } catch {
      DatabaseCtor = null; // row watches inert on runtimes without node:sqlite
    }
    // env PI_SESSION_ID is only guaranteed in bash-tool children; the session
    // manager is the source of truth inside the extension.
    const sessionId = ctx.sessionManager.getSessionId() ?? process.env.PI_SESSION_ID;
    if (!sessionId) return; // not a pi session — nothing to scope wakes to
    if (timer) clearInterval(timer);
    core.setSession(sessionId); // stamps session start → older lines prime silently
    void tick();
    timer = setInterval(tick, INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
  });
}

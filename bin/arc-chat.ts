#!/usr/bin/env bun
// arc-chat — user-facing chat surface for the ephemeral interviewer (ADR 0003).
//
//   arc-chat post <message> [--thread T]    write chat_in row, return thread_id
//   arc-chat tail [--thread T] [--once]     stream chat_out rows for thread
//   arc-chat threads [--limit N]            list recent threads
//
// All state lives in the ledger. No daemons. The factory's fast-pass pool
// (ARC_SLOTS_INTERACTIVE) claims chat_in rows and emits chat_out rows tagged
// with the same thread_id.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open, openWithMigrate } from "../src/ledger/db";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEDGER = join(REPO, "bin", "ledger.ts");
const DB_FLAG = process.env.ARC_LEDGER_DB ? ["--db", process.env.ARC_LEDGER_DB] : [];

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

function die(msg: string, code = 1): never {
  process.stderr.write(`arc-chat: ${msg}\n`);
  process.exit(code);
}

function newThreadId(): string {
  return `t-${Math.floor(Date.now() / 1000).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

switch (cmd) {
  case "post": {
    const message = args[1];
    if (!message || message.startsWith("--")) die("usage: post <message> [--thread T]", 2);
    const thread = getFlag("thread") ?? newThreadId();
    // Truncate title; full message in body for replay.
    const title = message.length > 80 ? message.slice(0, 77) + "..." : message;
    const r = spawnSync(
      "bun",
      [
        LEDGER, "create",
        "--kind", "event",
        "--type", "interactive",
        "--source-module", "arc-chat",
        "--title", title,
        "--body", message,
        "--thread", thread,
        "--agent", "arc-chat",
        ...DB_FLAG,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) die(`ledger create failed: ${r.stderr}`);
    let id: string | undefined;
    try { id = JSON.parse(r.stdout).id; } catch { /* ignore */ }
    process.stdout.write(JSON.stringify({ thread_id: thread, id }) + "\n");
    break;
  }

  case "tail": {
    const thread = getFlag("thread");
    if (!thread) die("usage: tail --thread T [--once]", 2);
    const once = args.includes("--once");
    const db = openWithMigrate(process.env.ARC_LEDGER_DB);
    let lastSeen = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = db
        .query<{ id: string; title: string; body: string; state: string }, [string, string]>(
          `SELECT id, title, COALESCE(body_md, '') AS body, state
           FROM issues
           WHERE thread_id=? AND kind='reply' AND source_module='arc-chat' AND id > ?
           ORDER BY id`,
        )
        .all(thread, lastSeen);
      for (const r of rows) {
        process.stdout.write(JSON.stringify({ id: r.id, body: r.body || r.title, state: r.state }) + "\n");
        lastSeen = r.id;
      }
      if (once) break;
      await sleep(1000);
    }
    break;
  }

  case "threads": {
    const limit = parseInt(getFlag("limit") ?? "20", 10);
    const db = open(process.env.ARC_LEDGER_DB);
    const rows = db
      .query<{ thread_id: string; last_id: string; turns: number }, [number]>(
        `SELECT thread_id, MAX(id) AS last_id, COUNT(*) AS turns
         FROM issues
         WHERE thread_id IS NOT NULL AND kind IN ('event','reply') AND source_module='arc-chat'
         GROUP BY thread_id
         ORDER BY last_id DESC
         LIMIT ?`,
      )
      .all(limit);
    for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
    break;
  }

  case undefined:
  case "-h":
  case "--help":
  case "help": {
    process.stdout.write(`arc-chat — chat surface for the ephemeral interviewer (ADR 0003)

  post <message> [--thread T]    write chat_in row; returns thread_id (new if omitted)
  tail --thread T [--once]       stream chat_out rows for thread
  threads [--limit N]            list recent threads

env: ARC_LEDGER_DB to override ledger path
`);
    break;
  }

  default:
    die(`unknown command: ${cmd}`, 2);
}

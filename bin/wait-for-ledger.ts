#!/home/aaron/.bun/bin/bun
// Poll ~/vault/ledger.db every 3s. Emit one JSON line to stdout when
// claimable rows exist for the given mode. Silent when zero.
// Consumed by claude Monitor tool in interactive panes.
//
// Modes:
//   --kind <kind>       worker: kind=<kind> (e.g. task)
//   --interviewer       interviewer: kind IN ('chat_in','encounter_reply')
//
// Optional:
//   --interval <sec>    poll interval, default 3
//   --heartbeat <sec>   force emit every N sec even if count unchanged, default 300
//   --db <path>         override db path

import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(name);
}

const kind = flag("--kind");
const interviewer = has("--interviewer");
if (!!kind === interviewer) {
  console.error("usage: wait-for-ledger.ts (--kind <kind> | --interviewer) [--interval sec] [--heartbeat sec] [--db path]");
  process.exit(2);
}

const interval = Number(flag("--interval") ?? 3) * 1000;
const heartbeat = Number(flag("--heartbeat") ?? 300) * 1000;
const dbPath = flag("--db") ?? `${process.env.HOME}/vault/ledger.db`;

const db = new Database(dbPath, { readonly: true });
db.exec("PRAGMA journal_mode=WAL;");

// S7: skip paused rows. ORDER BY is a no-op for COUNT but documents the
// canonical claim order (tier MAJOR / pool MINOR, oldest created_at tiebreak).
// Migration 017: priority column dropped; sort uses tier/pool CASE expressions.
const query = interviewer
  ? db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM issues WHERE kind='event' AND source_module IN ('arc-chat','arc-encounter') AND state='ready' AND claimed_by IS NULL AND paused=0 ORDER BY created_at ASC",
    )
  : db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM issues WHERE kind=? AND state='ready' AND claimed_by IS NULL AND paused=0 ORDER BY created_at ASC",
    );

const mode = interviewer ? "interviewer" : `worker:${kind}`;
let lastEmit = 0;
let lastCount = -1;

function emit(n: number, reason: "edge" | "heartbeat") {
  const line = JSON.stringify({
    wake: true,
    available: n,
    mode,
    reason,
    ts: new Date().toISOString(),
  });
  process.stdout.write(line + "\n");
  lastEmit = Date.now();
  lastCount = n;
}

function tick() {
  let n: number;
  try {
    const row = interviewer
      ? (query as ReturnType<typeof db.query<{ n: number }, []>>).get()
      : (query as ReturnType<typeof db.query<{ n: number }, [string]>>).get(kind!);
    n = row?.n ?? 0;
  } catch (e) {
    process.stderr.write(`poll error: ${(e as Error).message}\n`);
    return;
  }
  const now = Date.now();
  if (n > 0 && n !== lastCount) {
    emit(n, "edge");
  } else if (n > 0 && now - lastEmit >= heartbeat) {
    emit(n, "heartbeat");
  } else if (n === 0) {
    lastCount = 0;
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

tick();
setInterval(tick, interval);

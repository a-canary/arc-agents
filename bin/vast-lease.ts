#!/usr/bin/env bun
// vast-lease — cooperative lease lock + FIFO queue for shared vast.ai instances.
//
// Multiple Claude instances share one (or few) vast.ai GPU boxes. Without
// coordination two jobs trample each other's /workspace and VRAM. This is the
// shim every instance MUST call before using a vast box and after it's done.
//
// State lives in ~/vault/vast/<instance>/ (shared, per the vault=state rule):
//   lease.json   the current holder (atomic O_EXCL create; holds TTL + meta)
//   queue.jsonl  append-only FIFO of waiters (ticket per line)
//
// It is a COOPERATIVE lock: it does not stop a rogue process from sshing in,
// it coordinates well-behaved callers. Honor it.
//
// Subcommands:
//   acquire  --instance <id> --holder <name> [--ttl <sec>=3600] [--reason "..."] [--wait [--timeout <sec>=0]]
//            Atomically take the lease if free (or held by an expired/own/dead-pid lease).
//            Without --wait: exit 0 on success, 4 if held by someone else.
//            With --wait: enqueue a ticket and block until it's our turn AND the
//            lease is free, or --timeout elapses (0 = wait forever).
//   release  --instance <id> --holder <name>
//            Release iff we hold it (or it's expired). Pops us from the queue.
//   renew    --instance <id> --holder <name> [--ttl <sec>=3600]
//            Extend our lease TTL (heartbeat for long jobs).
//   status   --instance <id> [--json]
//            Show current holder (and whether expired / pid dead) + queue depth.
//   queue    --instance <id> [--json]
//            Show the waiter queue.
//   steal    --instance <id> --holder <name> [--ttl <sec>=3600] [--reason "..."]
//            Force-take even from a live lease. Last resort; logs the eviction.
//   reap-stale-leases [--instance <id>] [--all] [--dry-run] [--json]
//            Walk ~/vault/vast/*/lease.json and unlink leases whose holder PID
//            is gone (process died but TTL had not elapsed). Mirrors the
//            factory worker reaper's "dead handle" discipline. --instance
//            scopes to one box; default scans every subdir of VAULT/vast/.
//            --dry-run prints what would be reaped without touching disk.
//
// Reclaimable-lease clause (the "dead PID" gate):
//   A lease is reclaimable iff one of:
//     - the requester passed --force / steal
//     - isExpired(cur)  (TTL past)
//     - cur.holder === requester (we already own it)
//     - !pidExists(cur.pid)  (the recorded PID has no /proc/<pid>/ entry —
//       the holder process died without releasing)
//
// Exit codes: 0 ok, 2 usage error, 4 held by another (no-wait), 5 timed out (wait).

import { mkdirSync, openSync, closeSync, writeSync, readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}
function has(name: string): boolean {
  return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}
function die(msg: string, code = 2): never {
  console.error(`vast-lease: ${msg}`);
  process.exit(code);
}

const VAULT = process.env.VAULT_DIR || join(homedir(), "vault");
const ROOT = join(VAULT, "vast");

interface Lease {
  instance: string;
  holder: string;
  pid: number;
  acquiredAt: number; // epoch sec
  expiresAt: number; // epoch sec
  reason?: string;
  // Optional fields set by external lifecycle tools (e.g. vast-warmpool):
  released?: boolean;
  releasedReason?: string;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
function instDir(instance: string): string {
  const d = join(ROOT, instance);
  mkdirSync(d, { recursive: true });
  return d;
}
function leasePath(instance: string): string {
  return join(instDir(instance), "lease.json");
}
function queuePath(instance: string): string {
  return join(instDir(instance), "queue.jsonl");
}

function readLease(instance: string): Lease | null {
  const p = leasePath(instance);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Lease;
  } catch {
    return null; // corrupt -> treat as free
  }
}
function isExpired(l: Lease): boolean {
  return now() >= l.expiresAt;
}

// True iff /proc/<pid>/ exists (i.e. the kernel still tracks that PID as a
// live process). On Linux /proc is always mounted, but we guard the read
// anyway so a sandboxed/odd filesystem doesn't make us auto-reap live leases.
function pidExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!existsSync("/proc")) return true; // can't tell — assume alive (safe)
  try {
    return existsSync(`/proc/${pid}`);
  } catch {
    return true; // weird FS error — assume alive (safe)
  }
}

// Atomic write of the lease only when the file does NOT already exist.
// O_EXCL makes this race-safe across processes on the same filesystem.
function tryCreateLease(instance: string, l: Lease): boolean {
  const p = leasePath(instance);
  try {
    const fd = openSync(p, "wx"); // wx = O_CREAT|O_EXCL|O_WRONLY
    writeSync(fd, JSON.stringify(l, null, 2));
    closeSync(fd);
    return true;
  } catch (e: any) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}
// Replace an existing (expired/own) lease atomically via temp+rename.
function overwriteLease(instance: string, l: Lease): void {
  const p = leasePath(instance);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 2));
  renameSync(tmp, p);
}
function removeLease(instance: string): void {
  try { unlinkSync(leasePath(instance)); } catch {}
}

// Attempt one acquire. Returns true if WE now hold the lease.
function attemptAcquire(instance: string, holder: string, ttl: number, reason: string | undefined, force: boolean): boolean {
  const lease: Lease = {
    instance, holder, pid: process.pid,
    acquiredAt: now(), expiresAt: now() + ttl, reason,
  };
  const cur = readLease(instance);
  if (!cur) {
    if (tryCreateLease(instance, lease)) return true;
    // Lost the create race; re-read and fall through.
    return reReadAndTake(instance, lease, holder, force);
  }
  return reReadAndTake(instance, lease, holder, force);
}
function reReadAndTake(instance: string, lease: Lease, holder: string, force: boolean): boolean {
  const cur = readLease(instance);
  if (!cur) {
    return tryCreateLease(instance, lease);
  }
  // Reclaimable iff:
  //   - force (steal) was requested, OR
  //   - the existing lease's TTL has elapsed, OR
  //   - we already hold it, OR
  //   - the recorded PID is no longer alive (holder process died without
  //     releasing). Mirrors the factory worker reaper's "dead handle"
  //     discipline. A dead-PID lease is functionally identical to an expired
  //     one — the box is leased-but-unusable and only `steal` can free it.
  const reclaimable = force || isExpired(cur) || cur.holder === holder || !pidExists(cur.pid);
  if (reclaimable) {
    overwriteLease(instance, lease);
    // Confirm we actually won (guard against a competing overwrite).
    const after = readLease(instance);
    return !!after && after.pid === lease.pid && after.holder === holder;
  }
  return false;
}

// ---- queue (FIFO of waiter tickets) ----
interface Ticket { holder: string; pid: number; ts: number; }
function readQueue(instance: string): Ticket[] {
  const p = queuePath(instance);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) as Ticket; } catch { return null; }
  }).filter((t): t is Ticket => !!t);
}
function writeQueue(instance: string, q: Ticket[]): void {
  const p = queuePath(instance);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, q.map((t) => JSON.stringify(t)).join("\n") + (q.length ? "\n" : ""));
  renameSync(tmp, p);
}
function enqueueOnce(instance: string, holder: string): void {
  const q = readQueue(instance);
  if (!q.some((t) => t.holder === holder && t.pid === process.pid)) {
    appendFileSync(queuePath(instance), JSON.stringify({ holder, pid: process.pid, ts: now() } as Ticket) + "\n");
  }
}
function dequeueSelf(instance: string, holder: string): void {
  const q = readQueue(instance).filter((t) => !(t.holder === holder && t.pid === process.pid));
  writeQueue(instance, q);
}
function atHeadOfQueue(instance: string, holder: string): boolean {
  const q = readQueue(instance);
  if (q.length === 0) return true;
  const head = q[0]!;
  return head.holder === holder && head.pid === process.pid;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function cmdAcquire() {
  const instance = flag("instance") || die("--instance required");
  const holder = flag("holder") || die("--holder required");
  const ttl = parseInt(flag("ttl") || "3600", 10);
  const reason = flag("reason");
  const wait = has("wait");
  const timeout = parseInt(flag("timeout") || "0", 10);

  if (!wait) {
    if (attemptAcquire(instance, holder, ttl, reason, false)) {
      console.log(`acquired ${instance} for ${holder} (ttl ${ttl}s)`);
      process.exit(0);
    }
    const cur = readLease(instance)!;
    die(`held by ${cur.holder} (pid ${cur.pid}), expires in ${cur.expiresAt - now()}s; use --wait or steal`, 4);
  }

  enqueueOnce(instance, holder);
  const deadline = timeout > 0 ? now() + timeout : 0;
  while (true) {
    if (atHeadOfQueue(instance, holder) && attemptAcquire(instance, holder, ttl, reason, false)) {
      dequeueSelf(instance, holder);
      console.log(`acquired ${instance} for ${holder} (ttl ${ttl}s, waited)`);
      process.exit(0);
    }
    if (deadline && now() >= deadline) {
      dequeueSelf(instance, holder);
      die(`timed out after ${timeout}s waiting for ${instance}`, 5);
    }
    await sleep(5000);
  }
}

function cmdRelease() {
  const instance = flag("instance") || die("--instance required");
  const holder = flag("holder") || die("--holder required");
  const cur = readLease(instance);
  dequeueSelf(instance, holder);
  if (!cur) { console.log(`${instance} already free`); process.exit(0); }
  if (cur.holder === holder || isExpired(cur)) {
    removeLease(instance);
    console.log(`released ${instance}`);
    process.exit(0);
  }
  die(`cannot release ${instance}: held by ${cur.holder}, not ${holder}`, 4);
}

function cmdRenew() {
  const instance = flag("instance") || die("--instance required");
  const holder = flag("holder") || die("--holder required");
  const ttl = parseInt(flag("ttl") || "3600", 10);
  const cur = readLease(instance);
  if (!cur || cur.holder !== holder) die(`cannot renew: ${holder} does not hold ${instance}`, 4);
  overwriteLease(instance, { ...cur, expiresAt: now() + ttl });
  console.log(`renewed ${instance} (+${ttl}s)`);
}

function cmdStatus() {
  const instance = flag("instance") || die("--instance required");
  const cur = readLease(instance);
  const q = readQueue(instance);
  if (has("json")) {
    console.log(JSON.stringify({
      instance,
      lease: cur,
      expired: cur ? isExpired(cur) : null,
      pidAlive: cur ? pidExists(cur.pid) : null,
      queueDepth: q.length,
      queue: q,
    }, null, 2));
    return;
  }
  if (!cur) { console.log(`${instance}: FREE  (queue: ${q.length})`); return; }
  const exp = isExpired(cur);
  const pidDead = !pidExists(cur.pid);
  const tag = exp ? "EXPIRED" : "HELD";
  console.log(`${instance}: ${tag} by ${cur.holder} (pid ${cur.pid}${pidDead ? ", DEAD" : ""})  expires ${exp ? "ago " : "in "}${Math.abs(cur.expiresAt - now())}s${cur.reason ? `  reason: ${cur.reason}` : ""}  (queue: ${q.length})`);
}

function cmdQueue() {
  const instance = flag("instance") || die("--instance required");
  const q = readQueue(instance);
  if (has("json")) { console.log(JSON.stringify(q, null, 2)); return; }
  if (q.length === 0) { console.log(`${instance}: queue empty`); return; }
  q.forEach((t, i) => console.log(`${i + 1}. ${t.holder} (pid ${t.pid})  waiting ${now() - t.ts}s`));
}

function cmdSteal() {
  const instance = flag("instance") || die("--instance required");
  const holder = flag("holder") || die("--holder required");
  const ttl = parseInt(flag("ttl") || "3600", 10);
  const reason = flag("reason");
  const prev = readLease(instance);
  if (prev && !isExpired(prev) && prev.holder !== holder) {
    console.error(`vast-lease: STEALING ${instance} from live holder ${prev.holder} (pid ${prev.pid})`);
  }
  if (attemptAcquire(instance, holder, ttl, reason, true)) {
    console.log(`stole ${instance} for ${holder} (ttl ${ttl}s)`);
    process.exit(0);
  }
  die(`failed to steal ${instance}`, 4);
}

interface ReapReport { instance: string; holder: string; pid: number; reason: "pid dead"; }

function cmdReapStaleLeases() {
  const oneInstance = flag("instance");
  const dryRun = has("dry-run");

  const targets: string[] = [];
  if (oneInstance) {
    targets.push(oneInstance);
  } else {
    if (!existsSync(ROOT)) {
      if (has("json")) { console.log(JSON.stringify({ reaped: 0, items: [], dryRun }, null, 2)); return; }
      console.log("no vast instances to reap");
      process.exit(0);
    }
    for (const ent of readdirSync(ROOT, { withFileTypes: true })) {
      if (ent.isDirectory()) targets.push(ent.name);
    }
  }

  const reaped: ReapReport[] = [];
  for (const inst of targets) {
    const lease = readLease(inst);
    if (!lease) continue;                       // no lease on this box
    if (lease.released === true) continue;       // external tool already released it
    if (pidExists(lease.pid)) continue;          // holder is alive — leave alone
    reaped.push({ instance: inst, holder: lease.holder, pid: lease.pid, reason: "pid dead" });
    if (!dryRun) {
      removeLease(inst);
    }
  }

  if (has("json")) {
    console.log(JSON.stringify({ reaped: reaped.length, items: reaped, dryRun }, null, 2));
    return;
  }
  if (reaped.length === 0) {
    console.log(`no stale leases${oneInstance ? ` for ${oneInstance}` : ""}`);
    process.exit(0);
  }
  for (const r of reaped) {
    console.log(`${dryRun ? "would reap" : "reaped"} stale lease: ${r.instance} holder=${r.holder} pid=${r.pid} (dead)`);
  }
  process.exit(0);
}

switch (cmd) {
  case "acquire": await cmdAcquire(); break;
  case "release": cmdRelease(); break;
  case "renew": cmdRenew(); break;
  case "status": cmdStatus(); break;
  case "queue": cmdQueue(); break;
  case "steal": cmdSteal(); break;
  case "reap-stale-leases": cmdReapStaleLeases(); break;
  default:
    die(`unknown command '${cmd ?? ""}'. Use: acquire|release|renew|status|queue|steal|reap-stale-leases`);
}

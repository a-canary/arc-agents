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
// Reclaim semantics (see reReadAndTake):
//   A lease is reclaimable when (a) --force is set, (b) it is timestamp-expired,
//   (c) the caller already holds it, OR (d) the holder's recorded PID is no
//   longer alive (/proc/<pid>/ missing). The dead-PID case handles processes
//   that crashed / were killed without releasing the lease — the timestamp
//   alone is not enough because a long-TTL lease can outlive its holder for
//   hours.
//
// Subcommands:
//   acquire  --instance <id> --holder <name> [--ttl <sec>=3600] [--reason "..."] [--wait [--timeout <sec>=0]]
//            Atomically take the lease if free (or held by an expired/own/dead-PID lease).
//            Without --wait: exit 0 on success, 4 if held by someone else.
//            With --wait: enqueue a ticket and block until it's our turn AND the
//            lease is free, or --timeout elapses (0 = wait forever).
//   release  --instance <id> --holder <name>
//            Release iff we hold it (or it's expired / dead-PID). Pops us from the queue.
//   renew    --instance <id> --holder <name> [--ttl <sec>=3600]
//            Extend our lease TTL (heartbeat for long jobs).
//   status   --instance <id> [--json]
//            Show current holder (and whether expired or holder-PID dead) + queue depth.
//   queue    --instance <id> [--json]
//            Show the waiter queue.
//   steal    --instance <id> --holder <name> [--ttl <sec>=3600] [--reason "..."]
//            Force-take even from a live lease. Last resort; logs the eviction.
//   reap-stale-leases
//            Walk ~/vault/vast/*/lease.json and remove every lease whose holder
//            PID is no longer alive. Idempotent. Mirrors the factory's worker
//            reaper for tmux sessions.
//
// Exit codes: 0 ok, 2 usage error, 4 held by another (no-wait), 5 timed out (wait).

import { mkdirSync, openSync, closeSync, writeSync, readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from "fs";
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

// pidExists — does the kernel still know about this PID?
// On Linux, every live process has /proc/<pid>/. A crashed/killed process leaves
// no such dir. The function is platform-aware so the rest of the script can run
// on macOS for development; on non-Linux hosts it returns true (so leases
// behave as before — no spurious "dead PID" reclaims from a non-/proc FS).
function pidExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      statSync(`/proc/${pid}`);
      return true;
    } catch {
      return false;
    }
  }
  // Non-Linux fallback: try `kill -0` semantics via process.kill.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
// isHolderDead — true if the recorded holder PID is no longer a live process.
// A lease whose holder died is functionally identical to an expired one: the
// original writer can never release or renew it, so any other caller may
// reclaim it. (See grllm-59-specialization-without-memoriza for the original
// stuck-lease incident this guards against.)
function isHolderDead(l: Lease): boolean {
  return !pidExists(l.pid);
}
function isReclaimable(l: Lease, holder: string, force: boolean): boolean {
  return force || isExpired(l) || isHolderDead(l) || l.holder === holder;
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
// Replace an existing (expired/own/dead-PID) lease atomically via temp+rename.
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
  if (isReclaimable(cur, holder, force)) {
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
  const dph = flag("dph"); // optional; if set, record-estimate is called on success
  const wait = has("wait");
  const timeout = parseInt(flag("timeout") || "0", 10);

  // ponytail: --dph on acquire is OPTIONAL; when supplied we record the labelled
  // estimate via vast-billing so a later `vast-billing reconcile` has something
  // to override. Best-effort: never block lease acquire on billing-tool errors.
  function recordBillingEstimate() {
    if (!dph) return;
    const dphNum = Number(dph);
    if (!Number.isFinite(dphNum) || dphNum <= 0) return;
    try {
      const billingBin = join(import.meta.dir, "vast-billing.ts");
      const r = Bun.spawnSync(["bun", billingBin, "record-estimate", "--instance", instance, "--dph", String(dphNum), "--start", String(now())], { env: process.env });
      if (r.exitCode !== 0) console.error(`vast-lease: billing record-estimate failed (rc=${r.exitCode}); lease acquired anyway`);
    } catch (e) {
      console.error(`vast-lease: billing record-estimate threw; lease acquired anyway: ${(e as Error).message}`);
    }
  }

  if (!wait) {
    if (attemptAcquire(instance, holder, ttl, reason, false)) {
      recordBillingEstimate();
      console.log(`acquired ${instance} for ${holder} (ttl ${ttl}s)`);
      process.exit(0);
    }
    const cur = readLease(instance)!;
    die(`held by ${cur.holder} (pid ${cur.pid}${isHolderDead(cur) ? ", DEAD" : ""}), expires in ${cur.expiresAt - now()}s; use --wait or steal`, 4);
  }

  enqueueOnce(instance, holder);
  const deadline = timeout > 0 ? now() + timeout : 0;
  while (true) {
    if (atHeadOfQueue(instance, holder) && attemptAcquire(instance, holder, ttl, reason, false)) {
      dequeueSelf(instance, holder);
      recordBillingEstimate();
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
  if (cur.holder === holder || isExpired(cur) || isHolderDead(cur)) {
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
  const dead = cur ? isHolderDead(cur) : false;
  const exp = cur ? isExpired(cur) : false;
  if (has("json")) {
    console.log(JSON.stringify({
      instance,
      lease: cur,
      expired: cur ? (exp || dead) : null,
      holderDead: dead,
      queueDepth: q.length,
      queue: q,
    }, null, 2));
    return;
  }
  if (!cur) { console.log(`${instance}: FREE  (queue: ${q.length})`); return; }
  let state: string;
  if (exp) state = "EXPIRED";
  else if (dead) state = "HELD-BY-DEAD";
  else state = "HELD";
  console.log(`${instance}: ${state} by ${cur.holder} (pid ${cur.pid})  expires ${exp ? "ago " : "in "}${Math.abs(cur.expiresAt - now())}s${cur.reason ? `  reason: ${cur.reason}` : ""}  (queue: ${q.length})`);
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
  if (prev && !isExpired(prev) && !isHolderDead(prev) && prev.holder !== holder) {
    console.error(`vast-lease: STEALING ${instance} from live holder ${prev.holder} (pid ${prev.pid})`);
  }
  if (attemptAcquire(instance, holder, ttl, reason, true)) {
    console.log(`stole ${instance} for ${holder} (ttl ${ttl}s)`);
    process.exit(0);
  }
  die(`failed to steal ${instance}`, 4);
}

// Walk every ~/vault/vast/<instance>/lease.json and remove those whose
// holder PID is no longer alive. Idempotent; safe to run on a cron. Prints
// one line per reaped lease (or "no stale leases" if none).
function cmdReapStaleLeases() {
  if (!existsSync(ROOT)) { console.log("no vast/ directory; nothing to reap"); process.exit(0); }
  const entries = readdirSync(ROOT, { withFileTypes: true });
  let reaped = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const instance = e.name;
    const cur = readLease(instance);
    if (!cur) continue;
    if (isHolderDead(cur)) {
      console.log(`reaped ${instance} (holder=${cur.holder} pid=${cur.pid})`);
      removeLease(instance);
      reaped++;
    }
  }
  if (reaped === 0) console.log("no stale leases");
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

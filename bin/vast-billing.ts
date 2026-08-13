#!/usr/bin/env bun
// vast-billing — per-vast-instance spend reconciliation.
//
// Every vast.ai lease the factory holds burns dollars at the offer's `dph`
// (dollars-per-hour). The honest-spend premise (see ADR 0008) is that the
// ACTUAL bill is whatever vast.ai charges, not what we estimated at acquire
// time — offer `dph` can be wrong (storage delta, billed at a different rate
// per the invoice description), and any number we report from the local
// estimate is a guess until we cross-check it.
//
// This CLI is the cross-check. It is intentionally low-frequency (a single
// `reconcile` call reads ALL invoices once and walks every per-instance
// spend.json, so the cost is one REST call per N instances). The intended
// caller is the vast-lease cron (or any operator-driven audit), NOT every
// acquire/release cycle.
//
// Env var contract:
//   VASTAI_BIN  Path to the `vastai` CLI binary. Optional; when unset the
//               script falls back to ~/.local/bin/vastai (pipx shim). Exposed
//               as an explicit env var because the script runs under systemd/
//               cron where PATH does not include ~/.local/bin. The caller is
//               responsible for setting VASTAI_BIN when the CLI lives outside
//               the default PATH. When neither VASTAI_BIN nor ~/.local/bin/vastai
//               exists, the script fails open (skips reconcile, exits 0).
//
// State lives at ~/vault/vast/<instance>/spend.json:
//   rateEstimateDph    $/hr at lease-acquire time (labelled estimate)
//   estimateStartEpoch epoch sec the lease started
//   source             "estimate" (just recorded) or "invoice" (last reconciled)
//   actualCents        sum of invoice.amount for this instance, in cents
//   actualQuantityHr   sum of invoice.quantity (hours) for this instance
//   actualRateDph      weighted-average rate from invoices (dollars/hr)
//   lastReconciledAt   epoch ms of last successful reconcile; null if never
//
// Verbs:
//   record-estimate  --instance <id> --dph <$/hr> [--start <epoch>]
//                     Write the labelled estimate. Called by vast-lease acquire
//                     when --dph is supplied; called directly when back-filling.
//   reconcile        --instance <id> [--dry-run]
//                     Read `vastai show invoices --raw`, override spend.json
//                     with actuals for the named instance. FAIL-OPEN: a missing
//                     or erroring CLI leaves spend.json untouched.
//   reconcile        --all [--dry-run]
//                     Walk every ~/vault/vast/*/ with a spend.json, reconcile
//                     each. One CLI call total.
//   spend            --instance <id> [--json]
//                     Read spend.json, return best-known spend in cents
//                     (actual when source=invoice, else estimate*hours).
//
// Exit codes: 0 ok, 2 usage error, 4 not found / no spend data.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
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
  console.error(`vast-billing: ${msg}`);
  process.exit(code);
}

const VAULT = process.env.VAULT_DIR || join(homedir(), "vault");
const ROOT = join(VAULT, "vast");

// ponytail: env var contract documented in header above.
function resolveVastaiBin(): string | null {
  if (process.env.VASTAI_BIN) return process.env.VASTAI_BIN;
  const pipxShim = join(homedir(), ".local", "bin", "vastai");
  if (existsSync(pipxShim)) return pipxShim;
  return null;
}

// Spend record — single source of truth on disk.
interface Spend {
  instance: string;
  rateEstimateDph: number;          // $/hr at acquire time
  estimateStartEpoch: number;       // epoch sec
  source: "estimate" | "invoice";
  actualCents: number | null;       // sum of invoice.amount for this instance, in cents
  actualQuantityHr: number | null;  // sum of invoice.quantity (hours) for this instance
  actualRateDph: number | null;     // weighted-avg rate from invoices ($/hr)
  lastReconciledAt: number | null;  // epoch ms
}

function instDir(instance: string): string {
  const d = join(ROOT, instance);
  mkdirSync(d, { recursive: true });
  return d;
}
function spendPath(instance: string): string {
  return join(instDir(instance), "spend.json");
}
function readSpend(instance: string): Spend | null {
  const p = spendPath(instance);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Spend; } catch { return null; }
}
function writeSpend(s: Spend): void {
  const p = spendPath(s.instance);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  // Atomic-ish: rename (same filesystem), then write-through.
  // ponytail: temp+rename, not lock — same idiom as vast-lease; one writer per
  // instance is the contract (reconcile is low-freq, record-estimate is at
  // acquire time only).
  const fs = require("fs") as typeof import("fs");
  fs.renameSync(tmp, p);
}

// ---- record-estimate ----
function cmdRecordEstimate() {
  const instance = flag("instance") || die("--instance required");
  const dphStr = flag("dph") || die("--dph required");
  const dph = Number(dphStr);
  if (!Number.isFinite(dph) || dph <= 0) die(`--dph must be a positive finite number (got '${dphStr}')`);
  const startStr = flag("start");
  const start = startStr ? parseInt(startStr, 10) : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(start) || start <= 0) die(`--start must be a positive epoch-seconds integer (got '${startStr}')`);

  const s: Spend = {
    instance,
    rateEstimateDph: dph,
    estimateStartEpoch: start,
    source: "estimate",
    actualCents: null,
    actualQuantityHr: null,
    actualRateDph: null,
    lastReconciledAt: null,
  };
  writeSpend(s);
  console.log(`recorded estimate for ${instance}: $${dph}/hr from epoch ${start}`);
}

// ---- reconcile ----

interface InvoiceRow {
  amount: string;        // dollars, as a string ("0.178")
  description: string;
  instance_id?: number;  // present for per-instance charge lines
  quantity: string;      // hours, as a string ("4.008")
  rate: string;          // $/hr as a string
  timestamp: number;
  type: string;
}

function readInvoices(bin: string): InvoiceRow[] | null {
  // vast-cli skill: unset proxy before calling vastai (proxy intercepts REST).
  // We spawn with a clean env to avoid leaking the user's HTTP_PROXY, but
  // preserve the rest of the process env (especially VAST_API_KEY).
  const env: NodeJS.ProcessEnv = { ...process.env };
  const proxyVars = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
  for (const k of proxyVars) delete env[k];
  try {
    const r = Bun.spawnSync([bin, "show", "invoices", "--raw"], { env });
    if (r.exitCode !== 0) return null;
    const parsed = JSON.parse(r.stdout.toString()) as InvoiceRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

function aggregateForInstance(rows: InvoiceRow[], instance: string): { cents: number; qtyHr: number; weightedRateNumerator: number } | null {
  let cents = 0;
  let qtyHr = 0;
  let weightedRateNumerator = 0;
  let any = false;
  for (const row of rows) {
    if (String(row.instance_id) !== instance) continue;
    const amount = Number(row.amount);
    const qty = Number(row.quantity);
    const rate = Number(row.rate);
    if (!Number.isFinite(amount) || !Number.isFinite(qty) || !Number.isFinite(rate)) continue;
    cents += amount * 100; // dollars → cents
    qtyHr += qty;
    weightedRateNumerator += rate * qty;
    any = true;
  }
  return any ? { cents, qtyHr, weightedRateNumerator } : null;
}

function reconcileOne(instance: string, rows: InvoiceRow[], dryRun: boolean): "no-estimate" | "no-rows" | "updated" | "noop" {
  const existing = readSpend(instance);
  if (!existing) {
    console.error(`vast-billing: no estimate for ${instance}; record-estimate first`);
    return "no-estimate";
  }
  const agg = aggregateForInstance(rows, instance);
  if (!agg) return "noop"; // fail-open: leave as estimate

  const weightedRate = agg.qtyHr > 0 ? agg.weightedRateNumerator / agg.qtyHr : null;
  const next: Spend = {
    ...existing,
    source: "invoice",
    actualCents: agg.cents,
    actualQuantityHr: agg.qtyHr,
    actualRateDph: weightedRate,
    lastReconciledAt: Date.now(),
  };
  if (!dryRun) writeSpend(next);
  return "updated";
}

function cmdReconcile() {
  const all = has("all");
  const instance = flag("instance");
  if (!all && !instance) die("--instance <id> or --all required");
  if (all && instance) die("--instance and --all are mutually exclusive");

  const bin = resolveVastaiBin();
  if (!bin) {
    // Fail-open: log and exit 0. The caller (cron) shouldn't fail because the
    // host has no vast CLI installed yet.
    console.error("vast-billing: VASTAI_BIN not set and ~/.local/bin/vastai missing; skipping reconcile (fail-open)");
    process.exit(0);
  }
  const rows = readInvoices(bin);
  if (!rows) {
    // Fail-open: vast CLI errored (auth, network, parse). Keep all estimates.
    console.error(`vast-billing: ${bin} failed; skipping reconcile (fail-open)`);
    process.exit(0);
  }

  const dryRun = has("dry-run");

  if (all) {
    if (!existsSync(ROOT)) { console.log("no vast/ directory; nothing to reconcile"); process.exit(0); }
    const entries = readdirSync(ROOT, { withFileTypes: true });
    let updated = 0, noop = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const inst = e.name;
      if (!existsSync(spendPath(inst))) continue; // only reconcile what has an estimate
      const r = reconcileOne(inst, rows, dryRun);
      if (r === "updated") updated++;
      else if (r === "noop") noop++;
    }
    console.log(`reconcile-all: updated=${updated} noop=${noop} dryRun=${dryRun}`);
    process.exit(0);
  }

  const r = reconcileOne(instance!, rows, dryRun);
  switch (r) {
    case "no-estimate": process.exit(2); // usage error: nothing to reconcile
    case "noop": console.log(`${instance}: no invoice rows; kept estimate (fail-open)`); process.exit(0);
    case "updated": console.log(`${instance}: updated from invoice`); process.exit(0);
  }
}

// ---- spend ----
function cmdSpend() {
  const instance = flag("instance") || die("--instance required");
  const json = has("json");
  const s = readSpend(instance);
  if (!s) { console.error(`vast-billing: no spend record for ${instance}`); process.exit(4); }

  // Best-known: actual if reconciled, else estimate * (now - estimateStart).
  // estimateCents is always rateEstimateDph * elapsed_hours * 100, regardless of source.
  const elapsedHr = Math.max(0, (Date.now() / 1000) - s.estimateStartEpoch) / 3600;
  const estimateCents = Math.round(s.rateEstimateDph * elapsedHr * 100 * 100) / 100;
  let bestCents: number;
  if (s.source === "invoice" && s.actualCents !== null) {
    bestCents = s.actualCents;
  } else {
    bestCents = estimateCents;
  }
  const out = {
    instance,
    source: s.source,
    bestCents: Math.round(bestCents * 100) / 100,
    estimateCents,
    actualCents: s.actualCents,
    actualQuantityHr: s.actualQuantityHr,
    actualRateDph: s.actualRateDph,
    rateEstimateDph: s.rateEstimateDph,
    estimateStartEpoch: s.estimateStartEpoch,
    lastReconciledAt: s.lastReconciledAt,
  };
  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`${instance}: source=${out.source} best=$${(out.bestCents / 100).toFixed(4)} (actual=${out.actualCents !== null ? `$${(out.actualCents / 100).toFixed(4)}` : "n/a"}, estimate=$${out.rateEstimateDph}/hr)`);
  }
}

switch (cmd) {
  case "record-estimate": cmdRecordEstimate(); break;
  case "reconcile": cmdReconcile(); break;
  case "spend": cmdSpend(); break;
  default:
    die(`unknown command '${cmd ?? ""}'. Use: record-estimate|reconcile|spend`);
}
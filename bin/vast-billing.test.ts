import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "vast-billing.ts");

function run(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bun", [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function freshVault(): { vault: string; instance: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "vast-billing-test-"));
  const instance = "42453957";
  mkdirSync(join(vault, "vast", instance), { recursive: true });
  return {
    vault,
    instance,
    cleanup: () => rmSync(vault, { recursive: true, force: true }),
  };
}

const NOW = 1_783_900_000; // fixed clock for fixture determinism

// ponytail: this exists — single fixture-based test harness; the production
// `vastai show invoices` call is mocked at the CLI level via VASTAI_BIN env.

describe("vast-billing record-estimate (labelled estimate at lease-acquire time)", () => {
  let vault: string;
  let instance: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ vault, instance, cleanup } = freshVault());
  });
  afterEach(() => cleanup());

  it("writes spend.json with rateEstimateDph + estimateStartEpoch + source=estimate", () => {
    const r = run(
      ["record-estimate", "--instance", instance, "--dph", "0.178", "--start", "1782354060"],
      { VAULT_DIR: vault },
    );
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    expect(written.instance).toBe(instance);
    expect(written.rateEstimateDph).toBeCloseTo(0.178);
    expect(written.estimateStartEpoch).toBe(1782354060);
    expect(written.source).toBe("estimate");
    expect(written.lastReconciledAt).toBeNull();
  });

  it("rejects --dph with a non-positive or non-finite value", () => {
    const r = run(
      ["record-estimate", "--instance", instance, "--dph", "-1"],
      { VAULT_DIR: vault },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--dph");
    expect(existsSync(join(vault, "vast", instance, "spend.json"))).toBe(false);
  });

  it("defaults --start to current epoch when omitted", () => {
    const before = Math.floor(Date.now() / 1000);
    const r = run(
      ["record-estimate", "--instance", instance, "--dph", "0.5"],
      { VAULT_DIR: vault },
    );
    const after = Math.floor(Date.now() / 1000);
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    expect(written.estimateStartEpoch).toBeGreaterThanOrEqual(before);
    expect(written.estimateStartEpoch).toBeLessThanOrEqual(after);
  });
});

describe("vast-billing reconcile (override estimate with provider actuals)", () => {
  let vault: string;
  let instance: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ vault, instance, cleanup } = freshVault());
  });
  afterEach(() => cleanup());

  // Fixture: the real `vastai show invoices --raw` for instance 42453957.
  // The CLI is mocked via VASTAI_BIN pointing at a tiny bun script that
  // prints this JSON. The test never hits the network.
  function withMockInvoices(payload: unknown) {
    const mockPath = join(vault, "fake-vastai.ts");
    writeFileSync(mockPath, `#!/usr/bin/env bun\nconsole.log(JSON.stringify(${JSON.stringify(payload)}));\n`);
    chmodSync(mockPath, 0o755);
    return mockPath;
  }

  it("fails-open when VASTAI_BIN is missing on the host: keeps estimate as-is, exit 0", () => {
    // No spend.json yet — nothing to keep, but more importantly: no crash.
    // Point VASTAI_BIN at a path that definitively doesn't exist; the CLI
    // should exit 0 with a "fail-open" stderr message.
    const r = run(["reconcile", "--instance", instance], { VAULT_DIR: vault, VASTAI_BIN: "/nonexistent/vastai-missing" });
    expect(r.status).toBe(0); // fail-open
    expect(r.stderr).toMatch(/skipping reconcile|fail-open|missing|VASTAI_BIN/i);
    expect(existsSync(join(vault, "vast", instance, "spend.json"))).toBe(false);
  });

  it("fails-open when vastai errors out but estimate exists: leaves spend.json untouched", () => {
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.178, estimateStartEpoch: 1782354060, source: "estimate",
        actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null,
      }),
    );
    const mockPath = join(vault, "fake-vastai.ts");
    writeFileSync(mockPath, `#!/usr/bin/env bun\nprocess.exit(2);\n`);
    chmodSync(mockPath, 0o755);
    const r = run(["reconcile", "--instance", instance], { VAULT_DIR: vault, VASTAI_BIN: mockPath });
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    expect(after.source).toBe("estimate");
    expect(after.lastReconciledAt).toBeNull(); // never updated on failure
  });

  it("overrides estimate with actuals when an invoice row exists for the instance", () => {
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.178, estimateStartEpoch: 1782354060, source: "estimate",
        actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null,
      }),
    );
    const invoices = [
      {
        amount: "0.178",
        description: "Instance 42453957 storage charge: hours * $/hr",
        instance_id: 42453957,
        quantity: "4.008",
        rate: "0.0444",
        timestamp: 1783900800,
        type: "charge",
      },
    ];
    const mockPath = withMockInvoices(invoices);
    const r = run(["reconcile", "--instance", instance], { VAULT_DIR: vault, VASTAI_BIN: mockPath });
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    expect(after.source).toBe("invoice");
    expect(after.actualCents).toBeCloseTo(17.8); // 0.178 dollars → 17.8 cents
    expect(after.actualQuantityHr).toBeCloseTo(4.008);
    expect(after.actualRateDph).toBeCloseTo(0.0444);
    expect(after.lastReconciledAt).toBeGreaterThan(0);
  });

  it("sums multiple invoice rows for the same instance", () => {
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.10, estimateStartEpoch: NOW, source: "estimate",
        actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null,
      }),
    );
    const invoices = [
      { amount: "0.10", description: "Instance 42453957 charge", instance_id: 42453957, quantity: "1.0", rate: "0.10", timestamp: NOW, type: "charge" },
      { amount: "0.20", description: "Instance 42453957 charge", instance_id: 42453957, quantity: "2.0", rate: "0.10", timestamp: NOW, type: "charge" },
    ];
    const mockPath = withMockInvoices(invoices);
    const r = run(["reconcile", "--instance", instance], { VAULT_DIR: vault, VASTAI_BIN: mockPath });
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    expect(after.actualCents).toBeCloseTo(30.0); // 0.10 + 0.20 = 0.30 dollars = 30 cents
  });

  it("keeps estimate untouched when no invoice rows match the instance (fail-open)", () => {
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.5, estimateStartEpoch: NOW, source: "estimate",
        actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null,
      }),
    );
    const invoices = [
      // Other instances only — no row for `instance`
      { amount: "1.0", description: "Instance 99999999 charge", instance_id: 99999999, quantity: "1.0", rate: "1.0", timestamp: NOW, type: "charge" },
    ];
    const mockPath = withMockInvoices(invoices);
    const r = run(["reconcile", "--instance", instance], { VAULT_DIR: vault, VASTAI_BIN: mockPath });
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    expect(after.source).toBe("estimate");
    expect(after.actualCents).toBeNull();
  });

  it("--dry-run does not write spend.json", () => {
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.178, estimateStartEpoch: NOW, source: "estimate",
        actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null,
      }),
    );
    const invoices = [
      { amount: "0.178", description: "Instance 42453957 charge", instance_id: 42453957, quantity: "4.008", rate: "0.0444", timestamp: NOW, type: "charge" },
    ];
    const mockPath = withMockInvoices(invoices);
    const before = readFileSync(join(vault, "vast", instance, "spend.json"), "utf8");
    const r = run(["reconcile", "--instance", instance, "--dry-run"], { VAULT_DIR: vault, VASTAI_BIN: mockPath });
    expect(r.status).toBe(0);
    const after = readFileSync(join(vault, "vast", instance, "spend.json"), "utf8");
    expect(after).toBe(before); // untouched
  });

  it("reconcile --all walks every ~/vault/vast/*/ with a spend.json", () => {
    const inst2 = "11111111";
    mkdirSync(join(vault, "vast", inst2), { recursive: true });
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({ instance, rateEstimateDph: 0.178, estimateStartEpoch: NOW, source: "estimate", actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null }),
    );
    writeFileSync(
      join(vault, "vast", inst2, "spend.json"),
      JSON.stringify({ instance: inst2, rateEstimateDph: 0.2, estimateStartEpoch: NOW, source: "estimate", actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null }),
    );
    const invoices = [
      { amount: "0.178", description: "Instance 42453957 charge", instance_id: 42453957, quantity: "4.008", rate: "0.0444", timestamp: NOW, type: "charge" },
      { amount: "0.5", description: "Instance 11111111 charge", instance_id: 11111111, quantity: "2.5", rate: "0.2", timestamp: NOW, type: "charge" },
    ];
    const mockPath = withMockInvoices(invoices);
    const r = run(["reconcile", "--all"], { VAULT_DIR: vault, VASTAI_BIN: mockPath });
    expect(r.status).toBe(0);
    const a1 = JSON.parse(readFileSync(join(vault, "vast", instance, "spend.json"), "utf8"));
    const a2 = JSON.parse(readFileSync(join(vault, "vast", inst2, "spend.json"), "utf8"));
    expect(a1.source).toBe("invoice");
    expect(a2.source).toBe("invoice");
  });
});

describe("vast-billing spend (read best-known)", () => {
  let vault: string;
  let instance: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ vault, instance, cleanup } = freshVault());
  });
  afterEach(() => cleanup());

  it("returns estimate-only output when only the labelled estimate is on disk", () => {
    const start = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.5, estimateStartEpoch: start, source: "estimate",
        actualCents: null, actualQuantityHr: null, actualRateDph: null, lastReconciledAt: null,
      }),
    );
    const r = run(["spend", "--instance", instance, "--json"], { VAULT_DIR: vault });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.source).toBe("estimate");
    expect(Math.abs(parsed.estimateCents - 50.0)).toBeLessThan(0.05); // 0.5 * 1h = 0.5 dollars = 50 cents (allow test-clock drift)
    expect(Math.abs(parsed.bestCents - 50.0)).toBeLessThan(0.05); // best === estimate (within 0.05 cents; allow test-clock drift)
  });

  it("returns actual cents as best when invoice has been reconciled", () => {
    writeFileSync(
      join(vault, "vast", instance, "spend.json"),
      JSON.stringify({
        instance, rateEstimateDph: 0.5, estimateStartEpoch: NOW, source: "invoice",
        actualCents: 12.5, actualQuantityHr: 1.0, actualRateDph: 0.125, lastReconciledAt: NOW,
      }),
    );
    const r = run(["spend", "--instance", instance, "--json"], { VAULT_DIR: vault });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.source).toBe("invoice");
    expect(parsed.bestCents).toBeCloseTo(12.5);
  });

  it("exits 4 when no spend.json exists for the instance", () => {
    const r = run(["spend", "--instance", "nonexistent"], { VAULT_DIR: vault });
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/no spend/i);
  });
});
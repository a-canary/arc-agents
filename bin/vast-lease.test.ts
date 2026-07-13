import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "vast-lease.ts");

function run(args: string[], env: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync("bun", [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function freshVault(): { vault: string; instance: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "vast-lease-test-"));
  const instance = "test-inst";
  mkdirSync(join(vault, "vast", instance), { recursive: true });
  return {
    vault,
    instance,
    cleanup: () => rmSync(vault, { recursive: true, force: true }),
  };
}

describe("vast-lease dead-PID reclaim (regression: grllm-59-specialization-without-memoriza)", () => {
  let vault: string;
  let instance: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ vault, instance, cleanup } = freshVault());
  });
  afterEach(() => cleanup());

  it("treats a lease whose holder PID is dead as reclaimable by another holder", () => {
    // A live PID (init=1) holds the lease; another holder cannot reclaim it.
    const leasePath = join(vault, "vast", instance, "lease.json");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // not expired
    writeFileSync(
      leasePath,
      JSON.stringify({
        instance,
        holder: "stale-worker",
        pid: 1, // init — always alive on Linux
        acquiredAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: futureExpiry,
      }),
    );

    // Live PID → not reclaimable (without --force)
    const liveAttempt = run(["acquire", "--instance", instance, "--holder", "new-worker", "--ttl", "60"], { VAULT_DIR: vault });
    expect(liveAttempt.status).toBe(4);
    expect(liveAttempt.stderr).toContain("held by stale-worker");

    // Now overwrite with a dead PID; same expiry (not expired by timestamp)
    writeFileSync(
      leasePath,
      JSON.stringify({
        instance,
        holder: "stale-worker",
        pid: 2_147_483_647, // max int — never a real PID
        acquiredAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: futureExpiry,
      }),
    );

    // Dead PID → reclaimable by new holder, even though the timestamp is fresh
    const deadAttempt = run(["acquire", "--instance", instance, "--holder", "new-worker", "--ttl", "60"], { VAULT_DIR: vault });
    expect(deadAttempt.status).toBe(0);
    expect(deadAttempt.stdout).toContain("acquired");
    // Verify the lease was actually rewritten with the new holder
    const newLease = JSON.parse(require("node:fs").readFileSync(leasePath, "utf8"));
    expect(newLease.holder).toBe("new-worker");
    expect(newLease.pid).not.toBe(2_147_483_647);
  });

  it("treats a dead-PID lease as expired for the renew verb too", () => {
    const leasePath = join(vault, "vast", instance, "lease.json");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(
      leasePath,
      JSON.stringify({
        instance,
        holder: "stale-worker",
        pid: 2_147_483_647, // dead
        acquiredAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: futureExpiry,
      }),
    );

    // release should succeed because the lease is functionally expired (dead PID)
    const r = run(["release", "--instance", instance, "--holder", "stale-worker"], { VAULT_DIR: vault });
    expect(r.status).toBe(0);
    expect(existsSync(leasePath)).toBe(false);
  });

  it("reap-stale-leases removes leases whose holder PID is gone across all instances", () => {
    // Create two instances, both with dead-PID leases
    const inst2 = "test-inst-2";
    mkdirSync(join(vault, "vast", inst2), { recursive: true });
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const dead = { pid: 2_147_483_647, ts: futureExpiry };

    for (const inst of [instance, inst2]) {
      writeFileSync(
        join(vault, "vast", inst, "lease.json"),
        JSON.stringify({
          instance: inst,
          holder: `stale-${inst}`,
          pid: dead.pid,
          acquiredAt: Math.floor(Date.now() / 1000) - 60,
          expiresAt: dead.ts,
        }),
      );
    }

    const r = run(["reap-stale-leases"], { VAULT_DIR: vault });
    expect(r.status).toBe(0);
    expect(existsSync(join(vault, "vast", instance, "lease.json"))).toBe(false);
    expect(existsSync(join(vault, "vast", inst2, "lease.json"))).toBe(false);
  });

  it("reap-stale-leaves leaves leases with live PIDs alone", () => {
    const leasePath = join(vault, "vast", instance, "lease.json");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(
      leasePath,
      JSON.stringify({
        instance,
        holder: "live-worker",
        pid: 1, // init
        acquiredAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: futureExpiry,
      }),
    );

    const r = run(["reap-stale-leases"], { VAULT_DIR: vault });
    expect(r.status).toBe(0);
    expect(existsSync(leasePath)).toBe(true);
  });

  it("status reports expired=true for a dead-PID lease even when timestamp is fresh", () => {
    const leasePath = join(vault, "vast", instance, "lease.json");
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(
      leasePath,
      JSON.stringify({
        instance,
        holder: "stale-worker",
        pid: 2_147_483_647, // dead
        acquiredAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: futureExpiry,
      }),
    );

    const r = run(["status", "--instance", instance, "--json"], { VAULT_DIR: vault });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.expired).toBe(true);
  });

  // ponytail: --dph on acquire is the labelled-estimate handoff to vast-billing.
  // We don't deep-test vast-billing here (its own test file does); we only assert
  // that the spend.json file is created and contains a sensible record.
  it("acquire --dph records a labelled spend estimate via vast-billing", () => {
    const r = run(
      ["acquire", "--instance", instance, "--holder", "billing-test", "--ttl", "60", "--dph", "0.178"],
      { VAULT_DIR: vault },
    );
    expect(r.status).toBe(0);
    const spendPath = join(vault, "vast", instance, "spend.json");
    expect(existsSync(spendPath)).toBe(true);
    const s = JSON.parse(readFileSync(spendPath, "utf8"));
    expect(s.rateEstimateDph).toBeCloseTo(0.178);
    expect(s.source).toBe("estimate");
    expect(s.lastReconciledAt).toBeNull();
  });

  it("acquire without --dph does NOT write spend.json (back-compat path)", () => {
    const r = run(
      ["acquire", "--instance", instance, "--holder", "no-billing", "--ttl", "60"],
      { VAULT_DIR: vault },
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(vault, "vast", instance, "spend.json"))).toBe(false);
  });
});

// Claim must be bounded. Evidence 2026-08-20: `bun ledger.ts claim` spun
// 93.8% CPU for 248 min in state R against a contended ledger with a 910KB
// WAL, and worker-shell.sh had no guard on the call (npm/git worktree both
// had one). Two layers: db.ts sets busy_timeout so a contended ledger
// fails fast, worker-shell.sh wraps the call in `timeout` so a spin that
// busy_timeout can't see (userspace, not lock-blocked) still dies bounded.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWithMigrate } from "../src/ledger/db";

const BIN = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(BIN, "worker-shell.sh"), "utf8");

// Behavioural: claim against a write-locked ledger exits within the bound
// instead of hanging. The bound here is busy_timeout (5s) plus process
// startup; the 20s outer timeout is the failure detector.
test("claim against a write-locked ledger exits within the bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "claim-timeout-"));
  const dbPath = join(dir, "ledger.db");
  const db = openWithMigrate(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, state, hitl, kind, type, pool, created_at, updated_at)
     VALUES ('t1', 'arc-agents', 't1', 'b', 'ready', 0, 'task', 'quality', 'explore', strftime('%s','now'), strftime('%s','now'))`,
  );

  // Second connection holds the write lock for the duration of the claim.
  const blocker = new Database(dbPath);
  blocker.exec("PRAGMA journal_mode=WAL;");
  blocker.exec("BEGIN EXCLUSIVE;");

  const started = Date.now();
  const r = spawnSync(
    "bun",
    [join(BIN, "ledger.ts"), "claim", "test-worker", "--db", dbPath],
    { encoding: "utf8", timeout: 20_000 },
  );
  const elapsed = Date.now() - started;

  blocker.exec("ROLLBACK;");
  blocker.close();
  db.close();

  expect(r.signal).toBeNull(); // not killed by the 20s outer timeout
  expect(elapsed).toBeLessThan(15_000);
}, 30_000);

// Structural: the shell guard. worker-shell.sh is the bootstrap (pre-agent,
// bash) so it can't be exercised end-to-end here — assert the guard shape,
// same convention as worker-shell-blocked-no-work.test.ts.
function claimBlock(): string {
  const idx = SCRIPT.indexOf('CLAIM_JSON="$(');
  expect(idx).toBeGreaterThan(-1);
  return SCRIPT.slice(idx, SCRIPT.indexOf("CLAIM_ID=", idx));
}

test("worker-shell.sh wraps the claim call in a bounded timeout", () => {
  expect(claimBlock()).toMatch(/timeout \d+ bun "\$LEDGER_BIN" claim/);
});

test("worker-shell.sh reports claim-timeout on 124 and exits non-zero", () => {
  const block = claimBlock();
  expect(block).toContain("$CLAIM_RC -eq 124");
  expect(block).toContain("claim-timeout");
  // Timeout is a failure, not a lost race — must not exit 0 (which would
  // let the factory read it as "no work available").
  expect(block).not.toMatch(/claim-timeout[\s\S]*?exit 0/);
});

test("db.ts sets busy_timeout so a contended ledger fails fast", () => {
  const src = readFileSync(join(BIN, "../src/ledger/db.ts"), "utf8");
  expect(src).toContain("busy_timeout=");
});

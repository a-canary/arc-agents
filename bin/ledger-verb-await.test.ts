// ADR-0014 `await` — pure-read block until terminal (or barrier pass with
// --unblocked). Exit 0 merged/unblocked · 1 timeout · 2 not found · 3 cancelled · 4 failed.

import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-await-"));
  const db = join(dir, "t.db");
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const testEnv = { ...process.env, ARC_SKIP_MERGE_TRUTH: "1" };

async function run(db: string, ...args: string[]): Promise<unknown> {
  const r = await $`bun ${cli} ${args} --db ${db}`.env(testEnv).quiet();
  return JSON.parse(r.stdout.toString());
}

async function runRaw(db: string, ...args: string[]) {
  return await $`bun ${cli} ${args} --db ${db}`.env(testEnv).quiet().nothrow();
}

async function makeRow(db: string, title: string): Promise<string> {
  const r = (await run(
    db, "create", "--kind", "task", "--type", "mvp", "--title", title,
  )) as { id: string };
  return r.id;
}

test("await: missing id exits 2 with stderr", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "await", "no-such-row-xyz", "--timeout", "1", "--poll", "0.2");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("no such issue");
  } finally { cleanup(); }
});

test("await: already-merged row exits 0 immediately with reason=merged", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "await pre merged");
    await run(db, "update", id, "--state", "merged", "--no-diff", "--evidence", "test merge");
    const r = await runRaw(db, "await", id, "--timeout", "5", "--poll", "0.2");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { reason: string };
    expect(out.reason).toBe("merged");
  } finally { cleanup(); }
});

test("await: timeout on non-terminal row exits 1 with reason=timeout", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "await timeout row");
    const r = await runRaw(db, "await", id, "--timeout", "1", "--poll", "0.2");
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout.toString()) as { reason: string; state: string };
    expect(out.reason).toBe("timeout");
    expect(out.state).toBe("ready");
  } finally { cleanup(); }
});

test("await: wakes to exit 0 when row merges mid-wait", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "await flip merged");
    const p = $`bun ${cli} await ${id} --timeout 10 --poll 0.2 --db ${db}`.env(testEnv).quiet().nothrow();
    await Bun.sleep(500);
    await run(db, "update", id, "--state", "merged", "--no-diff", "--evidence", "test merge");
    const r = await p;
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { reason: string };
    expect(out.reason).toBe("merged");
  } finally { cleanup(); }
});

test("await: cancelled row exits 3", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "await flip cancelled");
    const p = $`bun ${cli} await ${id} --timeout 10 --poll 0.2 --db ${db}`.env(testEnv).quiet().nothrow();
    await Bun.sleep(500);
    await run(db, "cancel", id, "--reason", "test cancel");
    const r = await p;
    expect(r.exitCode).toBe(3);
    const out = JSON.parse(r.stdout.toString()) as { reason: string };
    expect(out.reason).toBe("cancelled");
  } finally { cleanup(); }
});

test("await: failed row exits 4", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "await flip failed");
    const p = $`bun ${cli} await ${id} --timeout 10 --poll 0.2 --db ${db}`.env(testEnv).quiet().nothrow();
    await Bun.sleep(500);
    await run(db, "update", id, "--state", "failed", "--evidence", "test failure");
    const r = await p;
    expect(r.exitCode).toBe(4);
    const out = JSON.parse(r.stdout.toString()) as { reason: string };
    expect(out.reason).toBe("failed");
  } finally { cleanup(); }
});

test("await --unblocked: exits 0 with reason=unblocked after wake past barrier", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(
      db, "create", "--kind", "task", "--type", "mvp", "--title", "await unblocked parent",
    )) as { id: string };
    const d = (await run(db, "decompose", p.id, "--child", "unblocked child")) as { children: { id: string }[] };
    const child = d.children[0]!.id;

    const waitP = $`bun ${cli} await ${p.id} --timeout 15 --poll 0.2 --unblocked --db ${db}`.env(testEnv).quiet().nothrow();
    await Bun.sleep(500);
    // Still blocked: merge child then wake parent past the barrier.
    await run(db, "update", child, "--state", "merged", "--no-diff", "--evidence", "test merge");
    await run(db, "wake", p.id);
    const r = await waitP;
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { reason: string };
    expect(out.reason).toBe("unblocked");
  } finally { cleanup(); }
});

test("await is pure read: emits no events", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "await pure read row");
    const countEvents = async () => ((await run(db, "show", id)) as { events: unknown[] }).events.length;
    const before = await countEvents();
    await runRaw(db, "await", id, "--timeout", "1", "--poll", "0.2");
    const after = await countEvents();
    expect(after).toBe(before);
  } finally { cleanup(); }
});

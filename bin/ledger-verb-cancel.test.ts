// ADR-0014 `cancel` — cancel a non-terminal row + 'reason' event. No child
// cascade; dependents get 'blocker-cancelled' but are NOT unblocked.
// Exit 0 cancelled · 1 refused (terminal row / missing reason) · 2 not found.

import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cancel-"));
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

test("cancel: missing id exits 2 with stderr", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "cancel", "no-such-row-xyz", "--reason", "x");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("no such issue");
  } finally { cleanup(); }
});

test("cancel: missing --reason exits 1", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "cancel no reason row");
    const r = await runRaw(db, "cancel", id);
    expect(r.exitCode).toBe(1);
  } finally { cleanup(); }
});

test("cancel: ready row → cancelled + 'reason' event, exit 0", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await makeRow(db, "cancel happy path");
    const r = await runRaw(db, "cancel", id, "--reason", "superseded by newer row");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { cancelled: boolean; dependents: string[] };
    expect(out.cancelled).toBe(true);
    expect(out.dependents).toEqual([]);

    const show = (await run(db, "show", id)) as { issue: { state: string }; events: { kind: string; payload_md: string }[] };
    expect(show.issue.state).toBe("cancelled");
    const reasonEvent = show.events.find((e) => e.kind === "reason");
    expect(reasonEvent?.payload_md).toBe("superseded by newer row");
  } finally { cleanup(); }
});

test("cancel: refuses terminal rows (merged, cancelled) with exit 1", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const m = await makeRow(db, "cancel refuse merged");
    await run(db, "update", m, "--state", "merged", "--no-diff", "--evidence", "test merge");
    expect((await runRaw(db, "cancel", m, "--reason", "x")).exitCode).toBe(1);

    const c = await makeRow(db, "cancel refuse cancelled");
    await run(db, "cancel", c, "--reason", "first cancel");
    expect((await runRaw(db, "cancel", c, "--reason", "second cancel")).exitCode).toBe(1);
  } finally { cleanup(); }
});

test("cancel: dependent gets 'blocker-cancelled' event and stays blocked", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(
      db, "create", "--kind", "task", "--type", "mvp", "--title", "cancel dependent parent",
    )) as { id: string };
    const d = (await run(db, "decompose", p.id, "--child", "cancel blocker child")) as { children: { id: string }[] };
    const child = d.children[0]!.id;

    const r = await runRaw(db, "cancel", child, "--reason", "blocker dropped");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { dependents: string[] };
    expect(out.dependents).toEqual([p.id]);

    const show = (await run(db, "show", p.id)) as { issue: { state: string }; events: { kind: string; payload_md: string }[] };
    expect(show.issue.state).toBe("blocked"); // NOT unblocked
    const ev = show.events.find((e) => e.kind === "blocker-cancelled");
    expect(ev?.payload_md).toContain(child);
  } finally { cleanup(); }
});

test("cancel: no cascade — children of a cancelled row stay ready", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const x = (await run(
      db, "create", "--kind", "task", "--type", "mvp", "--title", "cancel no cascade parent",
    )) as { id: string };
    const d = (await run(db, "decompose", x.id, "--child", "no cascade child")) as { children: { id: string }[] };
    const child = d.children[0]!.id;

    // Decompose flipped the parent to blocked; cancel it anyway.
    const r = await runRaw(db, "cancel", x.id, "--reason", "parent dropped");
    expect(r.exitCode).toBe(0);

    const show = (await run(db, "show", child)) as { issue: { state: string } };
    expect(show.issue.state).toBe("ready"); // child untouched
  } finally { cleanup(); }
});

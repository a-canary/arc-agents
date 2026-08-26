// ADR-0014 `wake` — targeted unblock re-eval. Exit 0 woke / already not
// blocked · 1 still blocked · 2 id not found.

import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-wake-"));
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

// Create a parent + one child via decompose → parent is state=blocked with
// blocked_by=[child]. Returns both ids.
async function makeBlockedPair(db: string): Promise<{ parent: string; child: string }> {
  const p = (await run(
    db, "create", "--kind", "task", "--type", "mvp", "--title", "wake parent task",
  )) as { id: string };
  const d = (await run(db, "decompose", p.id, "--child", "wake child task")) as { children: { id: string }[] };
  return { parent: p.id, child: d.children[0]!.id };
}

test("wake: missing id exits 2 with stderr", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "wake", "no-such-row-xyz");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("no such issue");
  } finally { cleanup(); }
});

test("wake: still blocked (pending child) exits 1 with pending list", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const { parent, child } = await makeBlockedPair(db);
    const r = await runRaw(db, "wake", parent);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout.toString()) as { woken: boolean; pending: string[] };
    expect(out.woken).toBe(false);
    expect(out.pending).toContain(child);
  } finally { cleanup(); }
});

test("wake: flips to ready + emits 'woken' event when trigger missed, exit 0", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const { parent, child } = await makeBlockedPair(db);
    // The unblock_dependents trigger already flips the parent on merge —
    // verify that, then re-block via raw SQL (missed-trigger simulation) and
    // confirm `wake` performs the targeted flip.
    await run(db, "update", child, "--state", "merged", "--no-diff", "--evidence", "test merge");
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run(`UPDATE issues SET state='blocked' WHERE id=?`, [parent]);
    raw.close();

    const r = await runRaw(db, "wake", parent);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { woken: boolean; state: string };
    expect(out.woken).toBe(true);
    expect(out.state).toBe("ready");

    const show = (await run(db, "show", parent)) as { issue: { state: string }; events: { kind: string }[] };
    expect(show.issue.state).toBe("ready");
    expect(show.events.some((e) => e.kind === "woken")).toBe(true);
  } finally { cleanup(); }
});

test("wake: idempotent on already-ready row exits 0 with woken:false", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(
      db, "create", "--kind", "task", "--type", "mvp", "--title", "wake ready row",
    )) as { id: string };
    const r = await runRaw(db, "wake", p.id);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { woken: boolean; state: string };
    expect(out.woken).toBe(false);
    expect(out.state).toBe("ready");
  } finally { cleanup(); }
});

test("wake: two-arm rule — cancelled blocker fails task arm, passes sprint arm", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    // Task parent (arm 1: all-merged required) + child.
    const t = (await run(
      db, "create", "--kind", "task", "--type", "mvp", "--title", "wake task arm parent",
    )) as { id: string };
    const td = (await run(db, "decompose", t.id, "--child", "task arm child")) as { children: { id: string }[] };
    await run(db, "cancel", td.children[0]!.id, "--reason", "test cancel");
    const rTask = await runRaw(db, "wake", t.id);
    expect(rTask.exitCode).toBe(1); // cancelled != merged for non-sprint

    // Sprint parent (arm 2: all-terminal required) + child. The
    // unblock_sprint_parents trigger already flips the parent to ready when
    // the blocker goes terminal — verify that, then re-block via raw SQL to
    // simulate a missed trigger and confirm `wake` backstops arm 2.
    const s = (await run(
      db, "create", "--kind", "sprint", "--type", "mvp", "--title", "wake sprint arm parent",
    )) as { id: string };
    const sd = (await run(db, "decompose", s.id, "--child", "sprint arm child")) as { children: { id: string }[] };
    await run(db, "cancel", sd.children[0]!.id, "--reason", "test cancel");
    const show = (await run(db, "show", s.id)) as { issue: { state: string } };
    expect(show.issue.state).toBe("ready"); // trigger did the flip

    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run(`UPDATE issues SET state='blocked' WHERE id=?`, [s.id]); // simulate missed trigger
    raw.close();
    const rSprint = await runRaw(db, "wake", s.id);
    expect(rSprint.exitCode).toBe(0); // cancelled is terminal for sprint
    const out = JSON.parse(rSprint.stdout.toString()) as { woken: boolean };
    expect(out.woken).toBe(true);
  } finally { cleanup(); }
});

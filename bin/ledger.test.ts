import { test, expect } from "bun:test";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  const db = join(dir, "t.db");
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(db: string, ...args: string[]): Promise<unknown> {
  const r = await $`bun ${cli} ${args} --db ${db}`.quiet();
  return JSON.parse(r.stdout.toString());
}

async function runRaw(db: string, ...args: string[]) {
  return await $`bun ${cli} ${args} --db ${db}`.quiet().nothrow();
}

test("init + create + list + claim", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const created = (await run(
      db,
      "create",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--title",
      "test task one",
    )) as { id: string; state: string };
    expect(created.state).toBe("ready");
    expect(created.id).toContain("test-task-one");

    const ready = (await run(db, "list", "--state", "ready")) as { id: string }[];
    expect(ready.length).toBe(1);

    const claimed = (await run(db, "claim", "w1")) as { claimed: string | null };
    expect(claimed.claimed).toBe(created.id);

    const none = (await run(db, "claim", "w1")) as { claimed: string | null };
    expect(none.claimed).toBeNull();
  } finally {
    cleanup();
  }
});

test("update --state + show events", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as {
      id: string;
    };
    await run(db, "update", c.id, "--state", "wip");
    const shown = (await run(db, "show", c.id)) as {
      issue: { state: string };
      events: unknown[];
    };
    expect(shown.issue.state).toBe("wip");
    expect(shown.events.length).toBeGreaterThanOrEqual(2);
  } finally {
    cleanup();
  }
});

test("blocked → cascade-on-merge unblocks dep", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const a = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "a")) as {
      id: string;
    };
    await run(
      db,
      "create",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--title",
      "b",
      "--blocked-by",
      JSON.stringify([a.id]),
    );
    await run(db, "update", a.id, "--state", "merged");
    const ready = (await run(db, "list", "--state", "ready")) as { title: string }[];
    expect(ready.map((r) => r.title)).toContain("b");
  } finally {
    cleanup();
  }
});

test("positional create is rejected", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "create", "task", "mvp", "some-title");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("positional");
  } finally {
    cleanup();
  }
});

test("bad type rejected with enum hint", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "create", "--kind", "task", "--type", "bogus", "--title", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/must be one of/);
  } finally {
    cleanup();
  }
});

test("claim picks HITL before mvp via priority sort", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "mvp-row");
    const h = (await run(db, "create", "--kind", "task", "--type", "HITL", "--title", "hitl-row")) as {
      id: string;
    };
    // ADR 0005: sort is (urgency, class, created_at, id). Pin HITL row to
    // (BUG, interactive) so it outranks mvp deterministically — without this
    // the test relied on alphabetical id-tiebreak luck.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run("UPDATE issues SET class='BUG', urgency='interactive' WHERE id=?", [h.id]);
    raw.close();
    const claimed = (await run(db, "claim", "w1")) as { claimed: string };
    expect(claimed.claimed).toBe(h.id);
  } finally {
    cleanup();
  }
});

test("tick reports reclaimed stale claims", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "old")) as {
      id: string;
    };
    await run(db, "claim", "w1");
    // Force claim age past 2hr.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run(`UPDATE issues SET claimed_at = strftime('%s','now') - 7300 WHERE id=?`, [c.id]);
    raw.close();
    const r = (await run(db, "tick")) as { unblocked: number; reclaimed: number; reclaimed_ids: string[] };
    expect(r.reclaimed).toBe(1);
    expect(r.reclaimed_ids).toEqual([c.id]);
  } finally {
    cleanup();
  }
});

test("update --hitl 1 flips column without state change", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "h")) as {
      id: string;
    };
    await run(db, "update", c.id, "--hitl", "1");
    const shown = (await run(db, "show", c.id)) as { issue: { hitl: number; state: string } };
    expect(shown.issue.hitl).toBe(1);
    expect(shown.issue.state).toBe("ready");
  } finally {
    cleanup();
  }
});

test("update --hitl rejects non-binary value", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "h2")) as {
      id: string;
    };
    const r = await runRaw(db, "update", c.id, "--hitl", "2");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/hitl/);
  } finally {
    cleanup();
  }
});

test("terminal state cannot transition", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "z")) as {
      id: string;
    };
    await run(db, "update", c.id, "--state", "merged");
    const r = await runRaw(db, "update", c.id, "--state", "ready");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/terminal/);
  } finally {
    cleanup();
  }
});

test("decompose: parent → blocked, N children created with HITL/ready", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "big work")) as { id: string };
    const r = (await run(db, "decompose", parent.id, "--child", "step one", "--child", "step two")) as {
      parent: string;
      children: { id: string; title: string }[];
    };
    expect(r.parent).toBe(parent.id);
    expect(r.children.length).toBe(2);

    const shown = (await run(db, "show", parent.id)) as { issue: { state: string; blocked_by: string } };
    expect(shown.issue.state).toBe("blocked");
    expect(JSON.parse(shown.issue.blocked_by)).toEqual(r.children.map((c) => c.id));

    for (const c of r.children) {
      const cs = (await run(db, "show", c.id)) as { issue: { state: string; type: string; kind: string; parent_id: string } };
      expect(cs.issue.state).toBe("ready");
      expect(cs.issue.type).toBe("HITL");
      expect(cs.issue.kind).toBe("task");
      expect(cs.issue.parent_id).toBe(parent.id);
    }
  } finally {
    cleanup();
  }
});

test("decompose: fanout cap of 5 enforced", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "p")) as { id: string };
    const r = await runRaw(
      db,
      "decompose",
      p.id,
      "--child", "a", "--child", "b", "--child", "c", "--child", "d", "--child", "e", "--child", "f",
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/fanout cap/);
  } finally {
    cleanup();
  }
});

test("decompose: rejects from terminal state", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "p")) as { id: string };
    await run(db, "update", p.id, "--state", "cancelled");
    const r = await runRaw(db, "decompose", p.id, "--child", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/terminal/);
  } finally {
    cleanup();
  }
});

test("claim + spawn-ready surface event-kind rows (ADR 0005 allowlist)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const ev = (await run(
      db,
      "create",
      "--kind", "event",
      "--type", "interactive",
      "--title", "chat in",
      "--source-module", "arc-chat",
    )) as { id: string };
    const ready = (await run(db, "spawn-ready")) as { id: string; kind: string }[];
    expect(ready.find((r) => r.id === ev.id)?.kind).toBe("event");
    const claimed = (await run(db, "claim", "w-evt")) as { claimed: string | null };
    expect(claimed.claimed).toBe(ev.id);
  } finally {
    cleanup();
  }
});

test("claim + spawn-ready skip non-allowlisted kinds (prd, reply, prefetch)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    for (const k of ["prd", "reply", "prefetch"] as const) {
      const extra = k === "reply" ? ["--source-module", "arc-chat"] : [];
      await run(db, "create", "--kind", k, "--type", "mvp", "--title", `${k} row`, ...extra);
    }
    const ready = (await run(db, "spawn-ready")) as unknown[];
    expect(ready.length).toBe(0);
    const claimed = (await run(db, "claim", "w-none")) as { claimed: string | null };
    expect(claimed.claimed).toBeNull();
  } finally {
    cleanup();
  }
});

test("scratch-gc lists stale dirs (dry-run) and --apply deletes", async () => {
  const { db, cleanup } = freshDb();
  const { mkdirSync, writeFileSync, utimesSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "scratch-root-"));
  try {
    const fresh = join(root, "fresh-proto");
    const stale = join(root, "stale-proto");
    mkdirSync(fresh);
    mkdirSync(stale);
    writeFileSync(join(fresh, "a.txt"), "x");
    writeFileSync(join(stale, "b.txt"), "y");
    // Backdate stale dir + file to 30d ago.
    const old = (Date.now() - 30 * 86400 * 1000) / 1000;
    utimesSync(join(stale, "b.txt"), old, old);
    utimesSync(stale, old, old);

    // (a) lists stale dirs (dry-run default)
    const dry = (await run(db, "scratch-gc", "--root", root, "--days", "14")) as {
      stale: { path: string }[];
      deleted: string[];
      apply: boolean;
    };
    expect(dry.apply).toBe(false);
    expect(dry.stale.map((s) => s.path)).toEqual([stale]);
    expect(dry.deleted).toEqual([]);
    expect(existsSync(stale)).toBe(true);

    // (b) --apply deletes
    const applied = (await run(db, "scratch-gc", "--root", root, "--days", "14", "--apply")) as {
      deleted: string[];
    };
    expect(applied.deleted).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("pause sets paused=1 and logs event (via bookie agent flag)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "p")) as {
      id: string;
    };
    const r = (await run(db, "pause", c.id, "--agent", "bookie")) as { paused: boolean };
    expect(r.paused).toBe(true);
    const shown = (await run(db, "show", c.id)) as {
      issue: { paused: number };
      events: { kind: string; agent: string; payload_md: string }[];
    };
    expect(shown.issue.paused).toBe(1);
    const ev = shown.events.find((e) => e.payload_md === "paused");
    expect(ev?.agent).toBe("bookie");
  } finally {
    cleanup();
  }
});

test("defer decrements priority by 100 and sets deferred_at", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "d")) as {
      id: string;
    };
    const r1 = (await run(db, "defer", c.id, "--agent", "bookie")) as {
      priority: number;
      deferred: boolean;
    };
    expect(r1.deferred).toBe(true);
    expect(r1.priority).toBe(-100);
    const r2 = (await run(db, "defer", c.id, "--agent", "bookie")) as { priority: number };
    expect(r2.priority).toBe(-200);
    const shown = (await run(db, "show", c.id)) as {
      issue: { priority: number; deferred_at: number };
    };
    expect(shown.issue.priority).toBe(-200);
    expect(shown.issue.deferred_at).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("pause/defer reject missing id", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const a = await runRaw(db, "pause");
    expect(a.exitCode).not.toBe(0);
    const b = await runRaw(db, "defer");
    expect(b.exitCode).not.toBe(0);
  } finally {
    cleanup();
  }
});

test("scratch-gc handles missing root gracefully", async () => {
  const { db, cleanup } = freshDb();
  try {
    const r = (await run(db, "scratch-gc", "--root", "/nonexistent/path/xyz")) as {
      stale: unknown[];
      note?: string;
    };
    expect(r.stale).toEqual([]);
    expect(r.note).toBe("root not found");
  } finally {
    cleanup();
  }
});

test("vacuum --events GCs old events on merged rows, retains last merged event", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const nowS = Math.floor(Date.now() / 1000);
    const oldTs = nowS - 60 * 86400; // 60d ago
    const recentTs = nowS - 5 * 86400; // 5d ago

    // 5 merged rows w/ events past cutoff (60d old), 2 within cutoff (5d).
    const pastIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", `past-${i}`)) as { id: string };
      pastIds.push(c.id);
      await run(db, "event", c.id, "progress", "p1");
      await run(db, "event", c.id, "progress", "p2");
      await run(db, "update", c.id, "--state", "merged");
    }
    const recentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", `recent-${i}`)) as { id: string };
      recentIds.push(c.id);
      await run(db, "event", c.id, "progress", "p1");
      await run(db, "update", c.id, "--state", "merged");
    }

    // Backdate past rows' events to oldTs; recent stays current.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    const upd = raw.prepare("UPDATE issue_events SET ts = ? WHERE issue_id = ?");
    for (const id of pastIds) upd.run(oldTs, id);
    for (const id of recentIds) upd.run(recentTs, id);
    raw.close();

    const r = (await run(db, "vacuum", "--events", "--older-than", "30")) as {
      events_deleted: number;
      older_than_days: number;
    };
    expect(r.older_than_days).toBe(30);
    // Each past row had 4 events (created, 2x progress, merged). The last
    // 'merged' event is retained; the other 3 are deleted. 5 rows × 3 = 15.
    expect(r.events_deleted).toBe(15);

    // Past rows: only the merged event remains as audit anchor.
    for (const id of pastIds) {
      const shown = (await run(db, "show", id)) as { events: { kind: string }[] };
      expect(shown.events.length).toBe(1);
      expect(shown.events[0]!.kind).toBe("merged");
    }
    // Recent rows: untouched (within cutoff).
    for (const id of recentIds) {
      const shown = (await run(db, "show", id)) as { events: unknown[] };
      expect(shown.events.length).toBe(3); // created, progress, merged
    }
  } finally {
    cleanup();
  }
});

// ADR 0006 §4 — vacuum GC of HITL deliveries + orphaned artifact blobs.

function insertPrompt(d: Database, id: string, state: string, createdAt: number, artifactPaths: string[] = []) {
  const payload = JSON.stringify({ prompt: "x", artifacts: artifactPaths.map((p) => ({ type: "image/png", path: p })) });
  d.run(
    `INSERT INTO hitl_prompts (id, created_at, kind, class, payload, recommended, state, timeout_sec)
     VALUES (?, ?, 'ask_text', 'taste', ?, 'y', ?, 60)`,
    [id, createdAt, payload, state],
  );
}

test("vacuum --deliveries: prunes terminal-prompt deliveries older than --older-than", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const d = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    const old = now - 40 * 24 * 3600;
    insertPrompt(d, "p-old-terminal", "answered", old);
    insertPrompt(d, "p-recent-terminal", "answered", now - 5 * 24 * 3600);
    insertPrompt(d, "p-old-open", "open", old);
    d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-old-terminal','arc-tui','retracted')`);
    d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-recent-terminal','arc-tui','retracted')`);
    d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-old-open','arc-tui','pending')`);
    d.close();

    const r = (await run(db, "vacuum", "--deliveries", "--older-than", "30")) as { deliveries_deleted: number };
    expect(r.deliveries_deleted).toBe(1);

    const d2 = new Database(db);
    const remaining = d2
      .query<{ prompt_id: string }, []>("SELECT prompt_id FROM hitl_deliveries ORDER BY prompt_id")
      .all()
      .map((x) => x.prompt_id);
    d2.close();
    expect(remaining).toEqual(["p-old-open", "p-recent-terminal"]);
  } finally {
    cleanup();
  }
});

test("vacuum --artifacts: unlinks blobs unreachable from live deliveries", async () => {
  const { db, cleanup } = freshDb();
  const home = mkdtempSync(join(tmpdir(), "vacuum-home-"));
  const artDir = join(home, "vault", "artifacts");
  mkdirSync(artDir, { recursive: true });
  const keep = join(artDir, "keep.png");
  const orphan = join(artDir, "orphan.png");
  writeFileSync(keep, "K".repeat(100));
  writeFileSync(orphan, "O".repeat(250));
  try {
    await run(db, "init");
    const d = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    insertPrompt(d, "p-live", "open", now, [keep]);
    insertPrompt(d, "p-dead", "answered", now, [orphan]);
    d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-live','arc-tui','delivered')`);
    d.run(`INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-dead','arc-tui','retracted')`);
    d.close();

    const proc = await $`HOME=${home} bun ${cli} vacuum --artifacts --db ${db}`.quiet();
    const r = JSON.parse(proc.stdout.toString()) as { artifacts_unlinked: number; artifacts_bytes_freed: number };
    expect(r.artifacts_unlinked).toBe(1);
    expect(r.artifacts_bytes_freed).toBe(250);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  } finally {
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("vacuum (no flags): runs all passes + SQLite VACUUM in one output", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "vacuum")) as Record<string, unknown>;
    expect(r).toHaveProperty("deliveries_deleted");
    expect(r).toHaveProperty("artifacts_unlinked");
    expect(r).toHaveProperty("vacuumed", true);
  } finally {
    cleanup();
  }
});

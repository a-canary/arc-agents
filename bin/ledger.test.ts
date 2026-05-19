import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
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

test("event verb appends row visible via show", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "ev")) as {
      id: string;
    };
    const r = (await run(db, "event", c.id, "note", "hello world")) as {
      logged: boolean;
    };
    expect(r.logged).toBe(true);
    const shown = (await run(db, "show", c.id)) as {
      events: { kind: string; payload_md: string }[];
    };
    const note = shown.events.find((e) => e.kind === "note");
    expect(note?.payload_md).toBe("hello world");
  } finally {
    cleanup();
  }
});

test("event verb rejects when id is missing", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "event");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/id required/);
  } finally {
    cleanup();
  }
});

test("compact archives merged rows past 30-day cutoff", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const old = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "old")) as {
      id: string;
    };
    const fresh = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "fresh")) as {
      id: string;
    };
    await run(db, "update", old.id, "--state", "merged");
    await run(db, "update", fresh.id, "--state", "merged");
    // Backdate `old` past 30 days; leave `fresh` at now.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run(`UPDATE issues SET updated_at = strftime('%s','now') - 31*24*3600 WHERE id=?`, [old.id]);
    raw.close();
    const r = (await run(db, "compact")) as { archived: number };
    expect(r.archived).toBe(1);
    const r2 = await runRaw(db, "show", old.id);
    expect(r2.exitCode).not.toBe(0);
    const stillThere = (await run(db, "show", fresh.id)) as { issue: { id: string } };
    expect(stillThere.issue.id).toBe(fresh.id);
  } finally {
    cleanup();
  }
});

test("compact on empty db is a no-op", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "compact")) as { archived: number };
    expect(r.archived).toBe(0);
  } finally {
    cleanup();
  }
});

test("vacuum on empty db succeeds", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "vacuum")) as { vacuumed: boolean };
    expect(r.vacuumed).toBe(true);
    // File still exists and readable.
    expect(statSync(db).size).toBeGreaterThan(0);
  } finally {
    cleanup();
  }
});

test("hitl emit class=taste without --recommended is rejected", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(
      db,
      "hitl", "emit",
      "--class", "taste",
      "--kind", "ask_confirm",
      "--prompt", "ok?",
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/recommended/);
  } finally {
    cleanup();
  }
});

test("hitl emit fans out to alive ux modules", async () => {
  const { db, cleanup } = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "arc-cfg-"));
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(
    cfgPath,
    `modules:\n  test-ui:\n    implements:\n      - ask_confirm\n    can_retract: true\n`,
  );
  try {
    await run(db, "init");
    // Mark module alive via heartbeat row.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run(`INSERT INTO ux_heartbeats (module_name, last_beat) VALUES (?, strftime('%s','now'))`, [
      "test-ui",
    ]);
    raw.close();
    const r = await $`bun ${cli} hitl emit --class impact --kind ask_confirm --prompt ${"go?"} --db ${db}`
      .env({ ...process.env, ARC_CONFIG: cfgPath })
      .quiet();
    const out = JSON.parse(r.stdout.toString()) as {
      id: string;
      deliveries: string[];
    };
    expect(out.deliveries).toEqual(["test-ui"]);
    const raw2 = new Database(db);
    const promptRow = raw2
      .query<{ kind: string; class: string }, [string]>(
        "SELECT kind, class FROM hitl_prompts WHERE id=?",
      )
      .get(out.id);
    expect(promptRow?.kind).toBe("ask_confirm");
    expect(promptRow?.class).toBe("impact");
    const deliv = raw2
      .query<{ module_name: string; state: string }, [string]>(
        "SELECT module_name, state FROM hitl_deliveries WHERE prompt_id=?",
      )
      .all(out.id);
    expect(deliv).toEqual([{ module_name: "test-ui", state: "pending" }]);
    raw2.close();
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
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

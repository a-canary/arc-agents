import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
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

test("hitl emit: refuses + atomically spawns install task when no alive module (U-0001)", async () => {
  const { db, cleanup } = freshDb();
  const cfgDir = mkdtempSync(join(tmpdir(), "ux-cfg-"));
  const cfgPath = join(cfgDir, "config.yaml");
  // Config declares a module that implements ask_choice — but no heartbeat will
  // be recorded, so the module is not alive.
  await Bun.write(
    cfgPath,
    "modules:\n  arc-tui:\n    cli: t\n    implements: [ask_choice]\n    renders: {}\n    can_retract: true\n",
  );
  try {
    await run(db, "init");
    const r = await $`bun ${cli} hitl emit --class taste --kind ask_choice --prompt "pick one" --option a --option b --recommended a --db ${db}`
      .env({ ...process.env, ARC_CONFIG: cfgPath })
      .quiet()
      .nothrow();
    expect(r.exitCode).toBe(2);
    const body = JSON.parse(r.stdout.toString()) as {
      refused: boolean;
      install_task: string;
    };
    expect(body.refused).toBe(true);
    expect(body.install_task).toContain("bootstrap-install-ux-module");
    // hitl_prompts row was NOT created; install task WAS created.
    const ready = (await run(db, "list", "--state", "ready")) as { id: string; title: string }[];
    expect(ready.length).toBe(1);
    expect(ready[0]!.id).toBe(body.install_task);
    expect(ready[0]!.title).toContain("ask_choice");
  } finally {
    cleanup();
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("hitl emit: proceeds when alive module implements kind (U-0001 happy path)", async () => {
  const { db, cleanup } = freshDb();
  const cfgDir = mkdtempSync(join(tmpdir(), "ux-cfg-"));
  const cfgPath = join(cfgDir, "config.yaml");
  await Bun.write(
    cfgPath,
    "modules:\n  arc-tui:\n    cli: t\n    implements: [ask_choice]\n    renders: {}\n    can_retract: true\n",
  );
  try {
    await run(db, "init");
    // Record a fresh heartbeat for arc-tui so it counts as alive.
    await $`bun ${cli} --db ${db}`.quiet().nothrow(); // no-op (ensure migrate ran via init)
    const { Database } = await import("bun:sqlite");
    const handle = new Database(db);
    handle.run(
      "INSERT INTO ux_heartbeats (module_name, last_beat) VALUES ('arc-tui', strftime('%s','now'))",
    );
    handle.close();

    const r = await $`bun ${cli} hitl emit --class taste --kind ask_choice --prompt "pick" --option a --option b --recommended a --db ${db}`
      .env({ ...process.env, ARC_CONFIG: cfgPath })
      .quiet()
      .nothrow();
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout.toString()) as {
      id: string;
      deliveries: string[];
    };
    expect(body.id).toStartWith("hitl-");
    expect(body.deliveries).toEqual(["arc-tui"]);
    // No install task spawned.
    const ready = (await run(db, "list", "--state", "ready")) as { id: string }[];
    expect(ready.length).toBe(0);
  } finally {
    cleanup();
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

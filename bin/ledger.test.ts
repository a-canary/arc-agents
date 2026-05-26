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

async function runRawNoDb(...args: string[]) {
  return await $`bun ${cli} ${args}`.quiet().nothrow();
}

async function runRaw(db: string, ...args: string[]) {
  return await $`bun ${cli} ${args} --db ${db}`.quiet().nothrow();
}

async function stubDiffReview(db: string, id: string): Promise<void> {
  await run(
    db,
    "event",
    id,
    "diff_review",
    JSON.stringify({
      consequences: [],
      surprises_vs_brief: [],
      gaps_vs_brief: [],
      adr_conflicts: [],
    }),
  );
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

test("update --state failed --evidence captures the reason in the event payload", async () => {
  // Triage regression: bookie was writing payload_md='→ failed' for every
  // failure, throwing away the human-readable reason even when --evidence was
  // supplied. Operators couldn't tell a flaky test apart from a worker timeout.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as {
      id: string;
    };
    await run(db, "update", c.id, "--state", "wip");
    await run(
      db,
      "update",
      c.id,
      "--state",
      "failed",
      "--evidence",
      "typecheck failed: src/foo.ts(42,10): TS2304",
      "--agent",
      "arc-worker-test",
    );
    const shown = (await run(db, "show", c.id)) as {
      events: { kind: string; payload_md: string; agent: string }[];
    };
    const failedEvent = shown.events.find((e) => e.kind === "failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.payload_md).toContain("typecheck failed");
    expect(failedEvent!.payload_md).toContain("TS2304");
    expect(failedEvent!.agent).toBe("arc-worker-test");
  } finally {
    cleanup();
  }
});

test("update --state merged --evidence captures the evidence in the event payload", async () => {
  // Symmetric to the failed case — merged events should also carry their
  // evidence (PR link, smoke-test output) so the audit trail is complete.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as {
      id: string;
    };
    await run(db, "update", c.id, "--state", "wip");
    await stubDiffReview(db, c.id);
    await run(
      db,
      "update",
      c.id,
      "--state",
      "merged",
      "--evidence",
      "PR #999 merged at abc1234; bun test 142/142",
    );
    const shown = (await run(db, "show", c.id)) as {
      events: { kind: string; payload_md: string }[];
    };
    const merged = shown.events.find((e) => e.kind === "merged");
    expect(merged).toBeDefined();
    expect(merged!.payload_md).toContain("PR #999");
    expect(merged!.payload_md).toContain("abc1234");
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
    await stubDiffReview(db, a.id);
    await run(db, "update", a.id, "--state", "merged");
    const ready = (await run(db, "list", "--state", "ready")) as { title: string }[];
    expect(ready.map((r) => r.title)).toContain("b");
  } finally {
    cleanup();
  }
});

test("list default excludes terminal rows; --all includes them", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    // Seed: 10 non-terminal + 200 merged via direct insert (fast path).
    const raw = new Database(db);
    const stmt = raw.prepare(
      `INSERT INTO issues (id, project, kind, type, title, body_md, state) VALUES (?, 'p', 'task', 'mvp', ?, '', ?)`,
    );
    for (let i = 0; i < 10; i++) stmt.run(`live-${i}`, `live ${i}`, "ready");
    for (let i = 0; i < 200; i++) stmt.run(`done-${i}`, `done ${i}`, "merged");
    // Also seed a few cancelled + failed to confirm exclusion.
    stmt.run("cx-1", "cx 1", "cancelled");
    stmt.run("fx-1", "fx 1", "failed");
    raw.close();

    // Default: only non-terminal.
    const defaulted = (await run(db, "list")) as { id: string; state: string }[];
    expect(defaulted.length).toBe(10);
    for (const r of defaulted) {
      expect(["merged", "cancelled", "failed"]).not.toContain(r.state);
    }

    // --state merged still works explicitly (raise limit so all 200 surface).
    const merged = (await run(db, "list", "--state", "merged", "--limit", "500")) as {
      state: string;
    }[];
    expect(merged.length).toBe(200);
    expect(merged.every((r) => r.state === "merged")).toBe(true);

    // --all includes terminal up to limit.
    const everything = (await run(db, "list", "--all", "--limit", "500")) as {
      state: string;
    }[];
    expect(everything.length).toBe(212);
  } finally {
    cleanup();
  }
}, 15000);

test("ls is an alias for list", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const raw = new Database(db);
    const stmt = raw.prepare(
      `INSERT INTO issues (id, project, kind, type, title, body_md, state) VALUES (?, 'p', 'task', 'mvp', ?, '', ?)`,
    );
    for (let i = 0; i < 3; i++) stmt.run(`r-${i}`, `row ${i}`, "ready");
    raw.close();

    const fromList = (await run(db, "list")) as { id: string }[];
    const fromLs = (await run(db, "ls")) as { id: string }[];
    expect(fromLs.map((r) => r.id).sort()).toEqual(fromList.map((r) => r.id).sort());
  } finally {
    cleanup();
  }
}, 10000);

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
    // Migration 017: sort is (tier, pool, created_at, id). Pin HITL row to
    // (prod, interactive) so it outranks mvp deterministically.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(db);
    raw.run("UPDATE issues SET tier='prod', pool='interactive' WHERE id=?", [h.id]);
    raw.close();
    const claimed = (await run(db, "claim", "w1")) as { claimed: string };
    expect(claimed.claimed).toBe(h.id);
  } finally {
    cleanup();
  }
});

test("create --tier --pool writes migration-017 fields (no longer silently tier_unset)", async () => {
  // Migration 017: class→tier, urgency→pool. CLI accepts both --class/--tier and
  // --urgency/--pool (backwards compat aliases). The INSERT must write the new
  // column names so the sort key works and rows don't all land in tier_unset.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(
      db,
      "create",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--title",
      "fix the thing",
      "--tier",
      "trust",
      "--pool",
      "interactive",
    )) as { id: string };
    const shown = (await run(db, "show", c.id)) as {
      issue: { tier: string; pool: string };
    };
    expect(shown.issue.tier).toBe("trust");
    expect(shown.issue.pool).toBe("interactive");
  } finally {
    cleanup();
  }
});

test("decompose children inherit parent's tier+pool (not tier_unset)", async () => {
  // Migration 017: class→tier, urgency→pool. HITL children spawned by AFK
  // decomposition must inherit the parent's tier+pool so a prod/interactive
  // decomposition stays prod/interactive rather than falling to tier_unset.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(
      db,
      "create",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--title",
      "parent",
      "--tier",
      "prod",
      "--pool",
      "interactive",
    )) as { id: string };
    const dec = (await run(db, "decompose", p.id, "--child", "kid-a", "--child", "kid-b")) as {
      children: { id: string }[];
    };
    for (const k of dec.children) {
      const shown = (await run(db, "show", k.id)) as {
        issue: { tier: string; pool: string };
      };
      expect(shown.issue.tier).toBe("prod");
      expect(shown.issue.pool).toBe("interactive");
    }
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
    await stubDiffReview(db, c.id);
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

test("decompose: claimed parent has claim fields nulled when flipped to blocked", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "claimed work")) as { id: string };
    await run(db, "claim", "w-decomp");
    const claimed = (await run(db, "show", parent.id)) as { issue: { state: string; claimed_by: string | null; claimed_at: number | null } };
    expect(claimed.issue.state).toBe("claimed");
    expect(claimed.issue.claimed_by).toBe("w-decomp");
    expect(claimed.issue.claimed_at).not.toBeNull();

    await run(db, "decompose", parent.id, "--child", "sub one");

    const shown = (await run(db, "show", parent.id)) as { issue: { state: string; claimed_by: string | null; claimed_at: number | null } };
    expect(shown.issue.state).toBe("blocked");
    expect(shown.issue.claimed_by).toBeNull();
    expect(shown.issue.claimed_at).toBeNull();
  } finally {
    cleanup();
  }
});

test("update --state blocked|failed|cancelled nulls claim fields", async () => {
  for (const terminalish of ["blocked", "failed", "cancelled"] as const) {
    const { db, cleanup } = freshDb();
    try {
      await run(db, "init");
      const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", `t-${terminalish}`)) as { id: string };
      await run(db, "claim", `w-${terminalish}`);
      const claimed = (await run(db, "show", c.id)) as { issue: { claimed_by: string | null; claimed_at: number | null } };
      expect(claimed.issue.claimed_by).toBe(`w-${terminalish}`);
      expect(claimed.issue.claimed_at).not.toBeNull();

      await run(db, "update", c.id, "--state", terminalish);

      const shown = (await run(db, "show", c.id)) as { issue: { state: string; claimed_by: string | null; claimed_at: number | null } };
      expect(shown.issue.state).toBe(terminalish);
      expect(shown.issue.claimed_by).toBeNull();
      expect(shown.issue.claimed_at).toBeNull();
    } finally {
      cleanup();
    }
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

// ── Change 5: Decompose per-child dimensions ──────────────────────────────────

test("decompose: bare string child inherits parent tier+pool, agent='agent_unset' (regression)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent task",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = (await run(db, "decompose", parent.id, "--child", "bare title")) as {
      parent: string;
      children: { id: string; title: string }[];
    };
    expect(r.children.length).toBe(1);
    const cs = (await run(db, "show", r.children[0]!.id)) as {
      issue: { tier: string; pool: string; agent: string };
    };
    expect(cs.issue.tier).toBe("mvp");
    expect(cs.issue.pool).toBe("build");
    expect(cs.issue.agent).toBe("agent_unset");
  } finally {
    cleanup();
  }
});

test("decompose: JSON child with agent override sets agent, tier+pool inherited", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent for agent override",
      "--tier", "trust", "--pool", "interactive")) as { id: string };
    const r = (await run(
      db, "decompose", parent.id,
      "--child", JSON.stringify({ title: "need a dev", agent: "developer" }),
    )) as { parent: string; children: { id: string; title: string }[] };
    expect(r.children.length).toBe(1);
    const cs = (await run(db, "show", r.children[0]!.id)) as {
      issue: { tier: string; pool: string; agent: string };
    };
    expect(cs.issue.agent).toBe("developer");
    expect(cs.issue.tier).toBe("trust");
    expect(cs.issue.pool).toBe("interactive");
  } finally {
    cleanup();
  }
});

test("decompose: JSON child with pool override deviates from parent pool", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent pool override",
      "--tier", "mvp", "--pool", "interactive")) as { id: string };
    const r = (await run(
      db, "decompose", parent.id,
      "--child", JSON.stringify({ title: "build subtask", pool: "build" }),
    )) as { parent: string; children: { id: string; title: string }[] };
    const cs = (await run(db, "show", r.children[0]!.id)) as {
      issue: { pool: string; tier: string };
    };
    expect(cs.issue.pool).toBe("build");
    expect(cs.issue.tier).toBe("mvp");
  } finally {
    cleanup();
  }
});

test("decompose: JSON child with bad agent enum → validation error, zero rows inserted", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent bad agent",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = await runRaw(
      db, "decompose", parent.id,
      "--child", JSON.stringify({ title: "bad child", agent: "wizard" }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/wizard/);
    // Parent should still be in its original state, no children inserted
    const shown = (await run(db, "show", parent.id)) as { issue: { state: string; blocked_by: string | null } };
    expect(shown.issue.state).toBe("ready");
    expect(shown.issue.blocked_by).toBeNull();
    const children = (await run(db, "list", "--state", "ready")) as { id: string }[];
    // Only the parent itself should be in ready state, no children
    const childIds = children.filter((c) => c.id !== parent.id);
    expect(childIds.length).toBe(0);
  } finally {
    cleanup();
  }
});

test("decompose: mixed batch (bare + JSON) is atomic, parent gets both child ids", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "sprint", "--type", "mvp", "--title", "sprint parent",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = (await run(
      db, "decompose", parent.id,
      "--child", "plain title",
      "--child", JSON.stringify({ title: "json child", agent: "developer", pool: "interactive" }),
    )) as { parent: string; children: { id: string; title: string }[] };
    expect(r.children.length).toBe(2);
    const shown = (await run(db, "show", parent.id)) as {
      issue: { state: string; blocked_by: string };
    };
    expect(shown.issue.state).toBe("blocked");
    const blockedBy = JSON.parse(shown.issue.blocked_by) as string[];
    expect(blockedBy).toContain(r.children[0]!.id);
    expect(blockedBy).toContain(r.children[1]!.id);

    const plain = (await run(db, "show", r.children[0]!.id)) as {
      issue: { agent: string; pool: string };
    };
    expect(plain.issue.agent).toBe("agent_unset");
    expect(plain.issue.pool).toBe("build"); // inherited

    const json = (await run(db, "show", r.children[1]!.id)) as {
      issue: { agent: string; pool: string };
    };
    expect(json.issue.agent).toBe("developer");
    expect(json.issue.pool).toBe("interactive"); // overridden
  } finally {
    cleanup();
  }
});

test("decompose: fanout cap still enforced with JSON children (6 → error)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const p = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "fanout-json")) as { id: string };
    const jsonChild = JSON.stringify({ title: "x" });
    const r = await runRaw(
      db, "decompose", p.id,
      "--child", jsonChild, "--child", jsonChild, "--child", jsonChild,
      "--child", jsonChild, "--child", jsonChild, "--child", jsonChild,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/fanout cap/);
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
      await stubDiffReview(db, c.id);
      await run(db, "update", c.id, "--state", "merged");
    }
    const recentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", `recent-${i}`)) as { id: string };
      recentIds.push(c.id);
      await run(db, "event", c.id, "progress", "p1");
      await stubDiffReview(db, c.id);
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
    // Each past row had 5 events (created, 2x progress, diff_review, merged).
    // The last 'merged' event is retained; the other 4 are deleted. 5 rows × 4 = 20.
    expect(r.events_deleted).toBe(20);

    // Past rows: only the merged event remains as audit anchor.
    for (const id of pastIds) {
      const shown = (await run(db, "show", id)) as { events: { kind: string }[] };
      expect(shown.events.length).toBe(1);
      expect(shown.events[0]!.kind).toBe("merged");
    }
    // Recent rows: untouched (within cutoff).
    for (const id of recentIds) {
      const shown = (await run(db, "show", id)) as { events: unknown[] };
      expect(shown.events.length).toBe(4); // created, progress, diff_review, merged
    }
  } finally {
    cleanup();
  }
}, 15000);

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

// hitl emit must persist expires_at so arc-tui (and any future reconciler) can
// reap prompts whose requesting worker has given up. Without it, a NULL
// expires_at is treated as "live forever" by every consumer query.
test("hitl emit with --timeout-sec persists expires_at = created_at + timeoutSec", async () => {
  const { db, cleanup } = freshDb();
  const cfgDir = mkdtempSync(join(tmpdir(), "ledger-cli-cfg-"));
  const cfgPath = join(cfgDir, "config.yaml");
  writeFileSync(
    cfgPath,
    `modules:\n  arc-tui:\n    cli: "arc-tui"\n    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]\n    renders:\n      text/markdown: native\n    can_retract: true\n`,
  );
  try {
    await run(db, "init");
    // Keep heartbeat fresh so pickModulesForHitl returns arc-tui.
    const d = new Database(db);
    d.run(
      `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES ('arc-tui', strftime('%s','now'))`,
    );
    d.close();

    const before = Math.floor(Date.now() / 1000);
    const r = await $`bun ${cli} hitl emit --class taste --kind ask_choice --prompt q --option a --option b --recommended a --timeout-sec 90 --db ${db}`
      .env({ ...process.env, ARC_CONFIG: cfgPath })
      .quiet();
    const after = Math.floor(Date.now() / 1000);
    const { id } = JSON.parse(r.stdout.toString()) as { id: string };

    const d2 = new Database(db);
    const got = d2
      .query<
        { expires_at: number | null; timeout_sec: number | null },
        [string]
      >("SELECT expires_at, timeout_sec FROM hitl_prompts WHERE id=?")
      .get(id);
    d2.close();
    expect(got!.timeout_sec).toBe(90);
    expect(got!.expires_at).not.toBeNull();
    // expires_at should land in [before+90, after+90].
    expect(got!.expires_at!).toBeGreaterThanOrEqual(before + 90);
    expect(got!.expires_at!).toBeLessThanOrEqual(after + 90);
  } finally {
    cleanup();
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

// ledger tick is the backstop reconciler. With no reconciler for expired hitl
// prompts they linger in state='open' forever and consumers (arc-tui list /
// answer) carry their own expires_at filter as a workaround. Tick should flip
// them to 'timeout_locked', which fires hitl_retract_losers to scrub deliveries.
test("tick flips expired open hitl_prompts to timeout_locked", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const d = new Database(db);
    // Seed two prompts: one expired (past), one live (future), one with NULL expires_at (must NOT be touched).
    const past = Math.floor(Date.now() / 1000) - 30;
    const future = Math.floor(Date.now() / 1000) + 3600;
    d.run(
      `INSERT INTO hitl_prompts (id, kind, class, payload, recommended, expires_at, timeout_sec)
       VALUES (?, 'ask_choice', 'taste', '{}', 'a', ?, 60),
              (?, 'ask_choice', 'taste', '{}', 'a', ?, 3600),
              (?, 'ask_choice', 'taste', '{}', 'a', NULL, NULL)`,
      ["p-expired", past, "p-live", future, "p-nullexp"],
    );
    // Delivery on expired prompt to verify retract trigger fires.
    d.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-expired', 'arc-tui', 'delivered')`,
    );
    d.close();

    const r = (await run(db, "tick")) as { expired?: number; expired_ids?: string[] };
    expect(r.expired).toBe(1);
    expect(r.expired_ids).toEqual(["p-expired"]);

    const d2 = new Database(db);
    const expired = d2
      .query<{ state: string }, [string]>("SELECT state FROM hitl_prompts WHERE id=?")
      .get("p-expired");
    const live = d2
      .query<{ state: string }, [string]>("SELECT state FROM hitl_prompts WHERE id=?")
      .get("p-live");
    const nullexp = d2
      .query<{ state: string }, [string]>("SELECT state FROM hitl_prompts WHERE id=?")
      .get("p-nullexp");
    const delivery = d2
      .query<{ state: string }, [string]>(
        "SELECT state FROM hitl_deliveries WHERE prompt_id=? AND module_name='arc-tui'",
      )
      .get("p-expired");
    d2.close();
    expect(expired!.state).toBe("timeout_locked");
    expect(live!.state).toBe("open");
    expect(nullexp!.state).toBe("open");
    expect(delivery!.state).toBe("retracted");
  } finally {
    cleanup();
  }
});

// Regression for the validation-bypass fix: `hitl emit` used to construct
// the payload as a plain object literal and INSERT directly, skipping the
// Zod schema in src/ledger/hitl-schemas.ts entirely. ask_text with an empty
// --prompt was silently persisted because the prior code had no Zod gate.
// Now both paths route through hitl-prompt.ts which calls parsePayload, so
// the command exits non-zero and no row is inserted.
test("hitl emit ask_text with empty --prompt fails Zod (was silently accepted)", async () => {
  const { db, cleanup } = freshDb();
  const cfgDir = mkdtempSync(join(tmpdir(), "ledger-cli-cfg-"));
  const cfgPath = join(cfgDir, "config.yaml");
  writeFileSync(
    cfgPath,
    `modules:\n  arc-tui:\n    cli: "arc-tui"\n    implements: [ask_text, ask_choice, ask_confirm, notify, show_artifact]\n    renders:\n      text/markdown: native\n    can_retract: true\n`,
  );
  try {
    await run(db, "init");
    const d = new Database(db);
    d.run(
      `INSERT INTO ux_heartbeats (module_name, last_beat) VALUES ('arc-tui', strftime('%s','now'))`,
    );
    d.close();

    const r = await $`bun ${cli} hitl emit --class taste --kind ask_text --prompt ${""} --recommended ok --db ${db}`
      .env({ ...process.env, ARC_CONFIG: cfgPath })
      .quiet()
      .nothrow();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString().toLowerCase()).toMatch(/prompt|validation|payload/);

    const d2 = new Database(db);
    const n = d2.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_prompts").get();
    d2.close();
    expect(n!.c).toBe(0);
  } finally {
    cleanup();
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("update --state merged refuses without prior diff_review event", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(
      db,
      "create",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--title",
      "no-review",
    )) as { id: string };
    const r = await runRaw(db, "update", c.id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/refuse merged: no diff_review/);
  } finally {
    cleanup();
  }
});

test("update --state merged accepts after diff_review event logged", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(
      db,
      "create",
      "--kind",
      "task",
      "--type",
      "mvp",
      "--title",
      "with-review",
    )) as { id: string };
    await stubDiffReview(db, c.id);
    const r = await runRaw(db, "update", c.id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).toBe(0);
  } finally {
    cleanup();
  }
});

// ── alias-cmd / resolve-alias (PR-1 new verbs) ──────────────────────────────

test("alias-cmd opus-max prints opus command containing {prompt}", async () => {
  const r = await runRawNoDb("alias-cmd", "opus-max");
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString().trim();
  expect(out).toContain("--model opus");
  expect(out).toContain("{prompt}");
});

test("alias-cmd <unknown> falls back to default_alias command", async () => {
  const r = await runRawNoDb("alias-cmd", "nonexistent-alias-xyz");
  expect(r.exitCode).toBe(0);
  // The default is minimax-build — just verify we get a non-empty command with {prompt}
  const out = r.stdout.toString().trim();
  expect(out.length).toBeGreaterThan(0);
  expect(out).toContain("{prompt}");
});

test("resolve-alias on DB without agent column returns default alias name", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "no-agent-col")) as { id: string };
    // In PR-1 the issues table has no `agent` column — resolve-alias must fall back.
    const r = await $`bun ${cli} resolve-alias ${c.id} --db ${db}`.quiet();
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString().trim();
    // Should be the default_alias name (a non-empty string, not a full command)
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(" "); // alias name has no spaces
    // TODO(PR-2): assert agent-column path once migration 016 lands
  } finally {
    cleanup();
  }
});

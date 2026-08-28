import { test, expect, describe } from "bun:test";
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  const db = join(dir, "t.db");
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Default test env skips the merge-truth precondition so existing tests can
// synthesize `merged` rows without spinning up a real GitHub PR. Tests that
// exercise the precondition explicitly use runStrict / runStrictRaw below.
const testEnv = { ...process.env, ARC_SKIP_MERGE_TRUTH: "1" };

async function run(db: string, ...args: string[]): Promise<unknown> {
  const r = await $`bun ${cli} ${args} --db ${db}`.env(testEnv).quiet();
  return JSON.parse(r.stdout.toString());
}

async function runRawNoDb(...args: string[]) {
  return await $`bun ${cli} ${args}`.quiet().nothrow();
}

async function runRaw(db: string, ...args: string[]) {
  return await $`bun ${cli} ${args} --db ${db}`.env(testEnv).quiet().nothrow();
}

async function runStrict(db: string, ...args: string[]): Promise<unknown> {
  const env = { ...process.env };
  delete env.ARC_SKIP_MERGE_TRUTH;
  const r = await $`bun ${cli} ${args} --db ${db}`.env(env).quiet();
  return JSON.parse(r.stdout.toString());
}

async function runStrictRaw(db: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.ARC_SKIP_MERGE_TRUTH;
  return await $`bun ${cli} ${args} --db ${db}`.env(env).quiet().nothrow();
}

async function stubDiffReview(db: string, id: string): Promise<void> {
  await run(
    db,
    "event",
    id,
    "diff_review",
    JSON.stringify({
      reviewer_identity: "stub-reviewer",
      reviewed_sha: "abcdef1234567890",
      verdict: "pass",
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

test("show works when --db precedes the verb/id", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as {
      id: string;
    };
    // --db before the verb (not just after, like the `run` helper's default
    // placement) previously made `show`/`join-status`/`claim`/`decompose`
    // misread the db path as the id positional.
    const r = await $`bun ${cli} --db ${db} show ${c.id}`.env(testEnv).quiet();
    const shown = JSON.parse(r.stdout.toString()) as { issue: { id: string } };
    expect(shown.issue.id).toBe(c.id);
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

test("list --created-by filters by the agent that emitted kind='created'", async () => {
  // Bookie/admin triage uses this to drop the post-hoc jq filter when asking
  // "what did <agent> file?" — joins issue_events to find the creator.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const a = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "alpha", "--agent", "bookie")) as { id: string };
    const b = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "beta", "--agent", "cli")) as { id: string };
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "gamma", "--agent", "bookie")) as { id: string };

    const bookieRows = (await run(db, "list", "--created-by", "bookie")) as {
      id: string;
      title: string;
    }[];
    expect(bookieRows.map((r) => r.title).sort()).toEqual(["alpha", "gamma"]);
    expect(bookieRows.map((r) => r.id)).toContain(a.id);
    expect(bookieRows.map((r) => r.id)).toContain(c.id);

    const cliRows = (await run(db, "list", "--created-by", "cli")) as {
      title: string;
    }[];
    expect(cliRows.map((r) => r.title)).toEqual(["beta"]);

    // Composes with --state + --limit: still applies the creator filter.
    const combo = (await run(
      db,
      "list",
      "--created-by",
      "bookie",
      "--state",
      "ready",
      "--limit",
      "5",
    )) as { title: string }[];
    expect(combo.length).toBe(2);
  } finally {
    cleanup();
  }
});

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

// Slice 2 (AXI P8): bare `ledger` (no args) prints the ready queue, not a
// usage screen. Stderr hint also appears under TTY.
test("bare `ledger` (no args) prints the ready queue (AXI P8)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const raw = new Database(db);
    const stmt = raw.prepare(
      `INSERT INTO issues (id, project, kind, type, title, body_md, state) VALUES (?, 'p', 'task', 'mvp', ?, '', ?)`,
    );
    stmt.run("bare-r-1", "ready row", "ready");
    stmt.run("bare-r-2", "ready row 2", "ready");
    stmt.run("bare-m-1", "merged row", "merged");
    raw.close();

    // No verb: bare invocation must return ready rows, not a usage screen.
    const env = { ...process.env, ARC_SKIP_MERGE_TRUTH: "1" };
    const r = await $`bun ${cli} --db ${db}`.env(env).quiet();
    const rows = JSON.parse(r.stdout.toString()) as { id: string; state: string }[];
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["bare-r-1", "bare-r-2"]);
    for (const row of rows) expect(row.state).toBe("ready");
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

test("update --agent and --project patch the row without state change", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "p", "--agent", "developer", "--project", "arc-agents")) as {
      id: string;
    };
    await run(db, "update", c.id, "--agent", "admin", "--project", "onenation");
    const shown = (await run(db, "show", c.id)) as {
      issue: { agent: string; project: string; state: string };
    };
    expect(shown.issue.agent).toBe("admin");
    expect(shown.issue.project).toBe("onenation");
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

test("decompose: parent → blocked, N children inherit parent type, state=ready", async () => {
  // Decompose children are normal worker tasks. They inherit the parent's
  // priority (`type`) instead of being hard-coded to `HITL`; HITL priority
  // is reserved for human-decision rows.
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
      const cs = (await run(db, "show", c.id)) as { issue: { state: string; type: string; kind: string; parent_id: string; hitl: number } };
      expect(cs.issue.state).toBe("ready");
      expect(cs.issue.type).toBe("mvp");
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

test("decompose: JSON child with body+project sets both, project deviates from parent", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent for body+project",
      "--tier", "mvp", "--pool", "build", "--project", "arc-agents")) as { id: string };
    const r = (await run(
      db, "decompose", parent.id,
      "--child", JSON.stringify({ title: "child with body", body: "the body text", project: "webui" }),
    )) as { parent: string; children: { id: string; title: string }[] };
    const cs = (await run(db, "show", r.children[0]!.id)) as {
      issue: { body_md: string; project: string };
    };
    expect(cs.issue.body_md).toBe("the body text");
    expect(cs.issue.project).toBe("webui");
  } finally {
    cleanup();
  }
});

test("decompose: JSON child with unrecognized field → validation error, zero rows inserted", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent bad field",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = await runRaw(
      db, "decompose", parent.id,
      "--child", JSON.stringify({ title: "bad child", acceptance: "nope" }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/unrecognized/);
  } finally {
    cleanup();
  }
});

test("decompose: top-level --title flag hard-errors instead of silently dropping", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent top-level flag",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = await runRaw(db, "decompose", parent.id, "--child", "kid", "--title", "oops", "--body", "oops2");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/does not accept top-level --title/);
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

// --dry-run must list candidates for every destructive pass and skip the
// apply step entirely: no row counts change, no files disappear, no SQLite
// VACUUM runs. Combinable with --events/--deliveries/--artifacts and the
// default (no sub-flag) path. Useful for inspecting before a destructive run.

test("vacuum dry-run: lists candidates for events + deliveries + artifacts, deletes nothing", async () => {
  // Acceptance: `bun test bin/ledger.test.ts -t 'vacuum dry-run' green;
  // verifies no rows deleted, output lists candidates.` The named test below
  // is the per-pass breakdown; this one is the umbrella check that exercises
  // all three passes in one dry-run invocation.
  const { db, cleanup } = freshDb();
  const home = mkdtempSync(join(tmpdir(), "vacuum-dryrun-umbrella-"));
  const artDir = join(home, "vault", "artifacts");
  mkdirSync(artDir, { recursive: true });
  const orphan = join(artDir, "orphan.png");
  writeFileSync(orphan, "X".repeat(123));
  try {
    await run(db, "init");
    const directDb = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    const old = now - 40 * 24 * 3600;
    // (a) merged row with old events
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "umbrella")) as { id: string };
    await run(db, "event", c.id, "progress", "p1");
    await stubDiffReview(db, c.id);
    await run(db, "update", c.id, "--state", "merged");
    directDb.run("UPDATE issue_events SET ts = ? WHERE issue_id = ? AND kind != 'merged'", [old, c.id]);
    // (b) terminal prompt with old delivery
    insertPrompt(directDb, "p-old", "answered", old);
    directDb.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-old','arc-tui','retracted')`,
    );
    directDb.close();

    const eventsBefore = new Database(db).query<{ c: number }, []>("SELECT COUNT(*) AS c FROM issue_events").get()!.c;
    const delivBefore = new Database(db).query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_deliveries").get()!.c;

    // Single dry-run invocation covers events + deliveries + artifacts.
    const proc = await $`HOME=${home} bun ${cli} vacuum --dry-run --db ${db}`.quiet();
    const r = JSON.parse(proc.stdout.toString()) as {
      dry_run: boolean;
      deliveries: { would_delete: number; candidates: unknown[] };
      artifacts: { would_unlink: number; candidates: { path: string; size: number }[] };
    };
    expect(r.dry_run).toBe(true);
    // 2 candidate events (progress + diff_review; created/merged excluded:
    //  created is recent, merged is the audit anchor).
    expect(r.deliveries.would_delete).toBe(1);
    expect(r.deliveries.candidates.length).toBe(1);
    expect(r.artifacts.would_unlink).toBe(1);
    expect(r.artifacts.candidates[0]!.path).toBe(orphan);

    // Apply path is gated: no rows deleted, no files removed.
    const eventsAfter = new Database(db).query<{ c: number }, []>("SELECT COUNT(*) AS c FROM issue_events").get()!.c;
    const delivAfter = new Database(db).query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_deliveries").get()!.c;
    expect(eventsAfter).toBe(eventsBefore);
    expect(delivAfter).toBe(delivBefore);
    expect(existsSync(orphan)).toBe(true);
  } finally {
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("vacuum --dry-run --events: lists event candidates, deletes nothing", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const nowS = Math.floor(Date.now() / 1000);
    const oldTs = nowS - 60 * 86400;

    // Merged row with 5 events: created, progress, progress, diff_review, merged.
    // With --older-than 30, 4 of those 5 are candidates (last 'merged' is the
    // audit anchor and is retained by the WHERE clause).
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "dry-events")) as { id: string };
    await run(db, "event", c.id, "progress", "p1");
    await run(db, "event", c.id, "progress", "p2");
    await stubDiffReview(db, c.id);
    await run(db, "update", c.id, "--state", "merged");
    const raw = new Database(db);
    raw.run("UPDATE issue_events SET ts = ? WHERE issue_id = ?", [oldTs, c.id]);
    raw.close();

    const before = (await run(db, "show", c.id)) as { events: { seq: number; kind: string }[] };
    const beforeSeqs = before.events.map((e) => e.seq).sort((a, b) => a - b);

    const r = (await run(db, "vacuum", "--events", "--older-than", "30", "--dry-run")) as {
      dry_run: boolean;
      older_than_days: number;
      events: { would_delete: number; candidates: { seq: number; issue_id: string; kind: string; ts: number }[] };
    };
    expect(r.dry_run).toBe(true);
    expect(r.older_than_days).toBe(30);
    expect(r.events.would_delete).toBe(4);
    expect(r.events.candidates.length).toBe(4);
    for (const cand of r.events.candidates) {
      expect(cand.issue_id).toBe(c.id);
      // The retained 'merged' event must NOT appear in candidates — it's the
      // audit anchor. The other three (created, 2x progress, diff_review) do.
      expect(cand.kind).not.toBe("merged");
      expect(["created", "progress", "diff_review"]).toContain(cand.kind);
    }

    // No rows deleted; the merged event is still last in created order.
    const after = (await run(db, "show", c.id)) as { events: { seq: number; kind: string }[] };
    const afterSeqs = after.events.map((e) => e.seq).sort((a, b) => a - b);
    expect(afterSeqs).toEqual(beforeSeqs);
  } finally {
    cleanup();
  }
});

test("vacuum --dry-run (no sub-flag): lists candidates for deliveries + artifacts, skips VACUUM", async () => {
  const { db, cleanup } = freshDb();
  const home = mkdtempSync(join(tmpdir(), "vacuum-dry-home-"));
  const artDir = join(home, "vault", "artifacts");
  mkdirSync(artDir, { recursive: true });
  const keep = join(artDir, "keep.png");
  const orphan = join(artDir, "orphan.png");
  writeFileSync(keep, "K".repeat(100));
  writeFileSync(orphan, "O".repeat(250));
  try {
    await run(db, "init");
    const directDb = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    const old = now - 40 * 24 * 3600;
    // Live prompt + delivery: keeps `keep.png` reachable.
    insertPrompt(directDb, "p-live", "open", now, [keep]);
    directDb.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-live','arc-tui','delivered')`,
    );
    // Terminal prompt + delivery: candidate for delivery GC; its artifact
    // `orphan.png` is unreachable once `p-dead` is GC'd, but the live-prompt
    // join in the artifact pass scans only `pending`/`delivered` deliveries,
    // so `orphan.png` is always unreachable and lands in the artifact list.
    insertPrompt(directDb, "p-dead", "answered", old);
    directDb.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-dead','arc-tui','retracted')`,
    );
    directDb.close();

    const countsBefore = (() => {
      const d = new Database(db);
      const deliveries = d.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_deliveries").get()!.c;
      d.close();
      return { deliveries };
    })();

    const proc = await $`HOME=${home} bun ${cli} vacuum --dry-run --db ${db}`.quiet();
    const r = JSON.parse(proc.stdout.toString()) as {
      dry_run: boolean;
      older_than_days: number;
      deliveries: { would_delete: number; candidates: { prompt_id: string; module_name: string; state: string }[] };
      artifacts: { would_unlink: number; would_free_bytes: number; candidates: { path: string; size: number }[] };
      vacuumed?: boolean;
    };

    expect(r.dry_run).toBe(true);
    expect(r.older_than_days).toBe(30);
    // One delivery (the one on the old terminal prompt) is a candidate; the
    // live delivery on `p-live` is excluded by the WHERE clause.
    expect(r.deliveries.would_delete).toBe(1);
    expect(r.deliveries.candidates.length).toBe(1);
    expect(r.deliveries.candidates[0]!.prompt_id).toBe("p-dead");
    expect(r.deliveries.candidates[0]!.module_name).toBe("arc-tui");
    expect(r.deliveries.candidates[0]!.state).toBe("retracted");
    // Both blobs are present on disk; only `orphan.png` is unreachable, so
    // it's the sole artifact candidate.
    expect(r.artifacts.would_unlink).toBe(1);
    expect(r.artifacts.would_free_bytes).toBe(250);
    expect(r.artifacts.candidates.map((a) => a.path)).toEqual([orphan]);
    expect(r.artifacts.candidates[0]!.size).toBe(250);
    // SQLite VACUUM is gated off in dry-run — must not appear.
    expect(r.vacuumed).toBeUndefined();

    // Zero mutations: rows unchanged, files unchanged.
    const countsAfter = (() => {
      const d = new Database(db);
      const deliveries = d.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_deliveries").get()!.c;
      d.close();
      return { deliveries };
    })();
    expect(countsAfter.deliveries).toBe(countsBefore.deliveries);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(orphan)).toBe(true);
  } finally {
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("vacuum --dry-run --deliveries / --artifacts scope to a single pass", async () => {
  // The default dry-run touches both passes. Scoped --dry-run --deliveries
  // must NOT enumerate artifact candidates; the artifact pass is skipped.
  // This is what an operator uses to inspect a single dimension of an
  // upcoming destructive run.
  const { db, cleanup } = freshDb();
  const home = mkdtempSync(join(tmpdir(), "vacuum-dry-scope-"));
  const artDir = join(home, "vault", "artifacts");
  mkdirSync(artDir, { recursive: true });
  const orphan = join(artDir, "orphan.png");
  writeFileSync(orphan, "O".repeat(80));
  try {
    await run(db, "init");
    const directDb = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    const old = now - 40 * 24 * 3600;
    insertPrompt(directDb, "p-old", "answered", old);
    directDb.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-old','arc-tui','retracted')`,
    );
    directDb.close();

    const delivOnly = await $`HOME=${home} bun ${cli} vacuum --dry-run --deliveries --db ${db}`.quiet();
    const d = JSON.parse(delivOnly.stdout.toString()) as {
      dry_run: boolean;
      deliveries: { would_delete: number; candidates: { prompt_id: string }[] };
      artifacts?: unknown;
    };
    expect(d.dry_run).toBe(true);
    expect(d.deliveries.would_delete).toBe(1);
    expect(d.deliveries.candidates[0]!.prompt_id).toBe("p-old");
    // Artifact pass was not requested; must be absent.
    expect(d.artifacts).toBeUndefined();

    const artOnly = await $`HOME=${home} bun ${cli} vacuum --dry-run --artifacts --db ${db}`.quiet();
    const a = JSON.parse(artOnly.stdout.toString()) as {
      dry_run: boolean;
      artifacts: { would_unlink: number; candidates: { path: string; size: number }[] };
      deliveries?: unknown;
    };
    expect(a.dry_run).toBe(true);
    expect(a.artifacts.would_unlink).toBe(1);
    expect(a.artifacts.candidates[0]!.path).toBe(orphan);
    expect(a.artifacts.candidates[0]!.size).toBe(80);
    expect(a.deliveries).toBeUndefined();
    // The orphan is still on disk: dry-run mutates nothing.
    expect(existsSync(orphan)).toBe(true);
  } finally {
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("vacuum (no flags) + --dry-run: explicit negative — apply is gated, not just unimplemented", async () => {
  // Make sure the existing default (apply) path is NOT affected: a destructive
  // run with the same fixture as the dry-run test still wipes the rows.
  // This guards against a regression where --dry-run accidentally poisons
  // the normal path (e.g. caching the candidate set and skipping the DELETE).
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const directDb = new Database(db);
    const now = Math.floor(Date.now() / 1000);
    const old = now - 40 * 24 * 3600;
    insertPrompt(directDb, "p-wipe", "answered", old);
    directDb.run(
      `INSERT INTO hitl_deliveries (prompt_id, module_name, state) VALUES ('p-wipe','arc-tui','retracted')`,
    );
    directDb.close();

    // First: dry-run. Deliveries row count unchanged.
    await run(db, "vacuum", "--dry-run");
    const afterDry = new Database(db);
    const c1 = afterDry.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_deliveries").get()!.c;
    afterDry.close();
    expect(c1).toBe(1);

    // Then: real run. Row is gone.
    const real = (await run(db, "vacuum")) as { deliveries_deleted: number };
    expect(real.deliveries_deleted).toBe(1);
    const afterApply = new Database(db);
    const c2 = afterApply.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hitl_deliveries").get()!.c;
    afterApply.close();
    expect(c2).toBe(0);
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

// --- diff_review payload contract (analysis-1780502957 Pattern 1 Part A) ----
// The legacy gate accepted "any diff_review event exists" — a worker could
// log its own review with reviewer_identity == row.claimed_by and close the
// row. The new gate requires the latest diff_review event to parse as
// JSON {reviewer_identity, reviewed_sha, verdict} AND the reviewer_identity
// to differ from the row's claimed_by.

async function seedClaimedRow(db: string, title: string, claimedBy: string): Promise<string> {
  // Create the row, then claim under our pinned worker id. Atomic, uses the
  // CLI's own sqlite handle, no second connection (WAL mis-use).
  const c = (await run(
    db,
    "create",
    "--kind",
    "task",
    "--type",
    "mvp",
    "--title",
    title,
  )) as { id: string };
  const claimed = (await run(db, "claim", claimedBy)) as { claimed: string | null };
  if (claimed.claimed !== c.id) {
    throw new Error(`claim picked '${claimed.claimed}', wanted '${c.id}' (test raced)`);
  }
  return c.id;
}

async function logDiffReviewRaw(db: string, id: string, payload: string): Promise<void> {
  // JSON.stringify + shell-escape is fiddly inside bun's $`` — pass the JSON
  // as a single positional arg, same way the CLI does.
  await run(db, "event", id, "diff_review", payload);
}

test("merged gate: rejects diff_review payload that is non-JSON", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "non-json", "arc-worker-a-x");
    await logDiffReviewRaw(db, id, "this is just prose, not a JSON object");
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/diff_review.*JSON|not valid JSON/i);
  } finally { cleanup(); }
});

test("merged gate: rejects diff_review payload missing required field", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "missing", "arc-worker-a-y");
    await logDiffReviewRaw(db, id, JSON.stringify({ reviewer_identity: "r", reviewed_sha: "abc1234" /* no verdict */ }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("verdict");
  } finally { cleanup(); }
});

test("merged gate: rejects diff_review with invalid reviewed_sha (not hex)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "bad-sha", "arc-worker-a-z");
    await logDiffReviewRaw(db, id, JSON.stringify({ reviewer_identity: "r", reviewed_sha: "not-a-sha", verdict: "pass" }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/reviewed_sha/);
  } finally { cleanup(); }
});

test("merged gate: rejects diff_review with invalid verdict", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "bad-verdict", "arc-worker-a-w");
    await logDiffReviewRaw(db, id, JSON.stringify({ reviewer_identity: "r", reviewed_sha: "abc1234", verdict: "approved" }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/verdict.*pass.*fail.*comment/);
  } finally { cleanup(); }
});

test("merged gate: rejects self-review when reviewer_identity == claimed_by", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "self-review", "arc-worker-a-7kcc01");
    await logDiffReviewRaw(db, id, JSON.stringify({
      reviewer_identity: "arc-worker-a-7kcc01",
      reviewed_sha: "abc1234",
      verdict: "pass",
    }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/self-review/i);
    expect(r.stderr.toString()).toContain("arc-worker-a-7kcc01");
  } finally { cleanup(); }
});

test("merged gate: rejects self-review case-insensitively", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "self-review-ci", "arc-worker-a-7kcc01");
    await logDiffReviewRaw(db, id, JSON.stringify({
      reviewer_identity: "ARC-WORKER-A-7KCC01", // case-insensitive match
      reviewed_sha: "abc1234",
      verdict: "pass",
    }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/self-review/i);
  } finally { cleanup(); }
});

test("merged gate: accepts valid contract with different reviewer_identity", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "valid", "arc-worker-a-7kcc01");
    await logDiffReviewRaw(db, id, JSON.stringify({
      reviewer_identity: "claude-afk-reviewer",
      reviewed_sha: "abcdef1",
      verdict: "pass",
    }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).toBe(0);
  } finally { cleanup(); }
});

test("merged gate: accepts verdict=fail (reviewer says no — gate still closes if THIS-WORKER is not the reviewer)", async () => {
  // verdict=fail is well-formed; the merge gate does not gate on verdict
  // (that's the reviewer's freedom). The row's owner decides whether to act.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "fail-verdict", "arc-worker-a-qq");
    await logDiffReviewRaw(db, id, JSON.stringify({
      reviewer_identity: "opus-rival",
      reviewed_sha: "abcdef1",
      verdict: "fail",
    }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).toBe(0);
  } finally { cleanup(); }
});

test("merged gate: uses the LATEST diff_review event, not the first", async () => {
  // First event is malformed (would be rejected); second is a valid contract
  // with a different reviewer_identity. Latest must win.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const id = await seedClaimedRow(db, "stale-then-valid", "arc-worker-a-rr");
    await logDiffReviewRaw(db, id, "not json first");
    await logDiffReviewRaw(db, id, JSON.stringify({
      reviewer_identity: "opus-second",
      reviewed_sha: "abc1234",
      verdict: "pass",
    }));
    const r = await runRaw(db, "update", id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).toBe(0);
  } finally { cleanup(); }
});

test("merged gate: legacy rows with null claimed_by skip self-review check", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "no-claim")) as { id: string };
    // claimed_by is null (no claim verb run) — gate must not fire self-review.
    await logDiffReviewRaw(db, c.id, JSON.stringify({
      reviewer_identity: "any-reviewer-name",
      reviewed_sha: "abc1234",
      verdict: "pass",
    }));
    const r = await runRaw(db, "update", c.id, "--state", "merged", "--evidence", "x");
    expect(r.exitCode).toBe(0);
  } finally { cleanup(); }
});

// ── alias-cmd / resolve-alias (PR-1 new verbs) ──────────────────────────────

test("alias-cmd prints the full failover group, one candidate per line", async () => {
  // Contract: output lines equal the configured candidate list for any alias
  // in the live config, in order. (Previously hardcoded a 2-candidate `smart`
  // group; the arc-llm-proxy cutover made all aliases single pi commands, so
  // pinning an alias name + line count here would rot on every config change.)
  const cfg = JSON.parse(
    readFileSync(new URL("../config.json", import.meta.url).pathname, "utf8"),
  ) as { exec_cli_alias: Record<string, string | string[]> };
  const entry = Object.entries(cfg.exec_cli_alias)[0];
  if (!entry) throw new Error("config.json exec_cli_alias is empty");
  const [name, raw] = entry;
  const group: string[] = Array.isArray(raw) ? raw : [raw];
  const r = await runRawNoDb("alias-cmd", name);
  expect(r.exitCode).toBe(0);
  const lines = r.stdout.toString().trim().split("\n");
  expect(lines).toEqual(group);
  for (const l of lines) expect(l).toContain("{prompt}");
});

test("alias-cmd <unknown> falls back to default_alias command", async () => {
  const r = await runRawNoDb("alias-cmd", "nonexistent-alias-xyz");
  expect(r.exitCode).toBe(0);
  // The default is minimax-build — just verify we get a non-empty command with {prompt}
  const out = r.stdout.toString().trim();
  expect(out.length).toBeGreaterThan(0);
  expect(out).toContain("{prompt}");
});

test("render-prompt: sprint row emits sprint frame text and agent-keyed header", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    // Create a sprint row via CLI
    const c = (await run(db, "create", "--kind", "sprint", "--type", "deferred", "--title", "test sprint")) as { id: string };
    // Set agent=sprint, pool=build directly — the create verb doesn't expose --agent
    // for the issues.agent column (only for issue_events.agent).
    const directDb = new Database(db);
    directDb.run("UPDATE issues SET agent='sprint', pool='build' WHERE id=?", [c.id]);
    directDb.close();
    const r = await $`bun ${cli} render-prompt ${c.id} --worker arc-worker-test --db ${db}`.quiet();
    expect(r.exitCode).toBe(0);
    const prompt = r.stdout.toString();
    // Header must use agent= and pool=, not type=
    const firstLine = prompt.split("\n")[0]!;
    expect(firstLine).toContain("agent=sprint");
    expect(firstLine).toContain("pool=build");
    expect(firstLine).not.toContain("type=");
    // Sprint frame distinctive text
    expect(prompt).toContain("re-entrant");
  } finally {
    cleanup();
  }
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

test("render-prompt thread replay includes prior event/reply rows in created_at order", async () => {
  // I-0002: worker-shell.sh calls `ledger render-prompt` after claim. For an
  // issue in a chat thread, the rendered prompt must include prior turns
  // ordered by created_at (oldest first), excluding the current row itself.
  // Speaker mapping: kind=event → [user], kind=reply → [you], source_module=arc-sprint → [handoff].
  //
  // The fixture below deliberately uses IDs in one order and created_at in
  // a different order to actually exercise the created_at contract — a
  // coincidental-id-order test would silently pass under the old `ORDER BY id`
  // bug. See src/worker/thread-context.ts for the SQL.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const directDb = new Database(db);
    // The current row the worker is about to handle. Has thread_id=T so the
    // replay path is taken; kind=task with source_module=arc-chat is what
    // interviewer produces (post-ADR-0005 a chat_in turn is kind=event;
    // kind=task is the live-task version that triggers render-prompt).
    const t0 = 1_700_000_000;
    directDb.run(
      `INSERT INTO issues (id, project, kind, type, title, body_md, state, thread_id, source_module, agent, tier, pool, created_at, updated_at)
       VALUES (?, 'p', 'task', 'mvp', 'current task', 'current task body', 'claimed', 'T1', 'arc-chat', 'developer', 'tier_unset', 'pool_unset', ?, ?)`,
      ["cur-1", t0 + 100, t0 + 100],
    );
    // Three prior turns. IDs are inserted in [a, b, c] order; created_at is in
    // [c, a, b] order. A buggy `ORDER BY id` would emit a, b, c — wrong.
    // Correct ordering by created_at must emit c, a, b.
    const turns: { id: string; kind: "event" | "reply"; body: string; created_at: number }[] = [
      // id=a, created_at=t0+30 → slot 2 in chronological order
      { id: "prior-a", kind: "event", body: "user message A", created_at: t0 + 30 },
      // id=b, created_at=t0+50 → slot 3
      { id: "prior-b", kind: "reply", body: "you replied B", created_at: t0 + 50 },
      // id=c, created_at=t0+10 → slot 1 (oldest)
      { id: "prior-c", kind: "event", body: "user message C (oldest)", created_at: t0 + 10 },
    ];
    for (const turn of turns) {
      directDb.run(
        `INSERT INTO issues (id, project, kind, type, title, body_md, state, thread_id, source_module, agent, tier, pool, created_at, updated_at)
         VALUES (?, 'p', ?, 'interactive', ?, ?, 'merged', 'T1', 'arc-chat', 'chat', 'tier_unset', 'pool_unset', ?, ?)`,
        [turn.id, turn.kind, turn.body, turn.body, turn.created_at, turn.created_at],
      );
    }
    // A row that should be filtered: kind=task with the same thread_id, but not
    // kind IN (event, reply). It must NOT appear in the replay.
    directDb.run(
      `INSERT INTO issues (id, project, kind, type, title, body_md, state, thread_id, source_module, agent, tier, pool, created_at, updated_at)
       VALUES (?, 'p', 'task', 'mvp', 'sibling task', 'sibling body', 'merged', 'T1', 'arc-chat', 'developer', 'tier_unset', 'pool_unset', ?, ?)`,
      ["sibling-1", t0 + 5, t0 + 5],
    );
    directDb.close();

    const r = await $`bun ${cli} render-prompt cur-1 --worker arc-worker-test --db ${db}`.quiet();
    expect(r.exitCode).toBe(0);
    const prompt = r.stdout.toString();

    // Header carries the thread id so downstream consumers can confirm the
    // replay path was actually taken (not the no-thread branch).
    expect(prompt.split("\n")[0]).toContain("thread=T1");

    // All three prior turns present.
    expect(prompt).toContain("[user] user message C (oldest)");
    expect(prompt).toContain("[user] user message A");
    expect(prompt).toContain("[you] you replied B");

    // Current row excluded (replay is prior context, not self).
    expect(prompt).not.toContain("current task body");

    // Disallowed kind (task) excluded even with same thread_id.
    expect(prompt).not.toContain("sibling task");

    // The "Prior turns in this thread (oldest first):" header is rendered.
    expect(prompt).toContain("Prior turns in this thread (oldest first):");

    // created_at ordering: C (t0+10) < A (t0+30) < B (t0+50).
    const idxC = prompt.indexOf("[user] user message C (oldest)");
    const idxA = prompt.indexOf("[user] user message A");
    const idxB = prompt.indexOf("[you] you replied B");
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxC);
    expect(idxB).toBeGreaterThan(idxA);
  } finally {
    cleanup();
  }
});

test("update --blocked-by is rejected (silently-dropped flag guard)", async () => {
  // Regression: bin/ledger.ts update used to ignore --blocked-by entirely,
  // returning {updated: true} while leaving the column NULL. Workers trusted
  // the success and thought they had wired the parent. The guard now errors
  // with a pointer to the `decompose` verb, which is the only writer of
  // parent.blocked_by.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "guard")) as {
      id: string;
    };
    const r = await runRaw(db, "update", c.id, "--blocked-by", '["x","y"]', "--state", "blocked");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/decompose/);
    // Flag value is not echoed back; row must be untouched.
    const shown = (await run(db, "show", c.id)) as { issue: { state: string; blocked_by: string | null } };
    expect(shown.issue.state).toBe("ready");
    expect(shown.issue.blocked_by).toBeNull();
  } finally {
    cleanup();
  }
});

test("update --state merged refused when pr_url null and no --pr supplied (strict mode)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as {
      id: string;
    };
    await run(db, "update", c.id, "--state", "wip");
    // diff_review event must exist before the merge-truth precondition runs;
    // contract: {reviewer_identity, reviewed_sha, verdict} (worker is fine —
    // claimed_by is empty since the row was never atomic-claimed via the
    // claim verb).
    await run(db, "event", c.id, "diff_review", JSON.stringify({
      reviewer_identity: "stub-reviewer",
      reviewed_sha: "abcdef1234567890",
      verdict: "pass",
    }));
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--evidence", "did the thing");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("refused");
    expect(r.stderr.toString()).toMatch(/--pr|--local-merged-sha/);
    const shown = (await run(db, "show", c.id)) as { issue: { state: string }; events: { kind: string; payload_md: string }[] };
    expect(shown.issue.state).toBe("wip");
    // Refusal must be recorded as a note event for audit trail.
    expect(shown.events.some((e) => e.kind === "note" && e.payload_md.includes("refused state=merged"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("update --state merged refused when --pr looks like a branch, not a URL/number (strict)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await run(db, "event", c.id, "diff_review", JSON.stringify({
      reviewer_identity: "stub-reviewer",
      reviewed_sha: "abcdef1234567890",
      verdict: "pass",
    }));
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--pr", "feat/foo", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("does not look like a PR URL");
  } finally {
    cleanup();
  }
});

test("update --state merged refused for non-hex --local-merged-sha (strict)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await run(db, "event", c.id, "diff_review", JSON.stringify({
      reviewer_identity: "stub-reviewer",
      reviewed_sha: "abcdef1234567890",
      verdict: "pass",
    }));
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--local-merged-sha", "not-a-sha", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("not a hex sha");
  } finally {
    cleanup();
  }
});

test("update --state merged via --local-merged-sha works when sha is on origin/main", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await run(db, "event", c.id, "diff_review", JSON.stringify({
      reviewer_identity: "stub-reviewer",
      reviewed_sha: "abcdef1234567890",
      verdict: "pass",
    }));
    // Use the sha of HEAD in this worktree — guaranteed to be reachable from
    // origin/main since the worktree was created off origin/main.
    const sha = (await $`git rev-parse HEAD`.cwd(new URL("..", import.meta.url).pathname).quiet()).stdout.toString().trim();
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--local-merged-sha", sha, "--evidence", "local landing");
    if (r.exitCode !== 0) {
      // Worktree may not have origin/main fetched; skip rather than fail noisily.
      const stderr = r.stderr.toString();
      if (stderr.includes("origin/main")) return;
      throw new Error(`unexpected: ${stderr}`);
    }
    const shown = (await run(db, "show", c.id)) as { issue: { state: string } };
    expect(shown.issue.state).toBe("merged");
  } finally {
    cleanup();
  }
});

test("update non-merged states are unaffected by precondition (strict)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    // wip, blocked, review, failed, cancelled are all fine without PR
    await runStrict(db, "update", c.id, "--state", "wip");
    await runStrict(db, "update", c.id, "--state", "review");
    await runStrict(db, "update", c.id, "--state", "failed", "--evidence", "broke");
    const shown = (await run(db, "show", c.id)) as { issue: { state: string } };
    expect(shown.issue.state).toBe("failed");
  } finally {
    cleanup();
  }
});

// ── A-0005 / cleanup-plan-dedupe-retire-orphan-projec: project must be lower-case ──

test("create --project rejects mixed-case with canonical suggestion", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "create", "--kind", "task", "--type", "mvp", "--title", "t", "--project", "Trading");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("project must be lower-case");
    expect(r.stderr.toString()).toContain("trading");
  } finally {
    cleanup();
  }
});

// Regression: positionalAfterVerb treated every --flag without "=" as
// value-taking, so a boolean flag (e.g. --json) immediately followed by a
// stray positional swallowed that positional as its "value" and the
// create-time "no positional args" guard never saw it (path-strip, 2026-08-04).
// --json is not a real create flag, so the unknown-flag guard now rejects it
// first — strictly stricter than the original swallow bug.
test("create --json <stray> dies on the unknown flag before any write", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "create", "--kind", "task", "--type", "mvp", "--title", "t", "--json", "stray");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("unknown flag for create: --json");
  } finally {
    cleanup();
  }
});

// The underlying positional-rejection guard must still fire for a genuinely
// stray positional (no boolean flag involved).
test("create <stray> rejects the stray positional", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "create", "--kind", "task", "--type", "mvp", "--title", "t", "stray");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("positional args not allowed for create");
  } finally {
    cleanup();
  }
});

test("create --project accepts lower-case", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "t", "--project", "arc-agents")) as { id: string };
    expect(c.id).toBeTruthy();
  } finally {
    cleanup();
  }
});

// Regression: empty/whitespace --project must NOT propagate empty to the row.
// ?? only substitutes on null/undefined; trim-then-fall-back defends at the
// bookie layer so callers can't accidentally mint project='' rows that the
// factory then misroutes into the arc-agents default worktree
// (analysis-1783934070.md Pattern 3, 2026-07-13).
test("create --project='' / whitespace normalises to arc-agents default", async () => {
  for (const p of ["", "   ", "\t"]) {
    const { db, cleanup } = freshDb();
    try {
      await run(db, "init");
      const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", `t-${p.length}`, "--project", p)) as { id: string };
      const r = (await run(db, "show", c.id)) as { issue: { project: string } };
      expect(r.issue.project).toBe("arc-agents");
    } finally {
      cleanup();
    }
  }
});

test("update --project rejects mixed-case", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "t", "--project", "arc-agents")) as { id: string };
    const r = await runRaw(db, "update", c.id, "--project", "Trading");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("project must be lower-case");
  } finally {
    cleanup();
  }
});

test("update --project accepts lower-case (regression: existing test relies on this)", async () => {
  // The pre-existing 'update --agent and --project patch the row' test uses
  // --project onenation — guard must not break that.
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "t", "--project", "arc-agents")) as { id: string };
    await run(db, "update", c.id, "--project", "onenation");
    const shown = (await run(db, "show", c.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("onenation");
  } finally {
    cleanup();
  }
});

test("feedback --project rejects mixed-case", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await runRaw(db, "feedback", "--project", "Trading", "--body", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("project must be lower-case");
  } finally {
    cleanup();
  }
});

// ── hygiene-emit project resolution (clarify-docs-hygiene-emit-caller-must-pa) ──
//
// hygiene-emit used to default project='arc-agents' regardless of which task
// triggered the followup. Worker-emitted followups for non-arc-agents tasks
// (e.g. expert-horde) silently landed in the wrong repo. The fix:
// --project wins; otherwise inherit from --observed-in-task; otherwise default.

test("hygiene-emit with explicit --project uses it", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "hygiene-emit", "--skill", "clarify-docs",
      "--title", "explicit project test",
      "--project", "expert-horde")) as { id: string; emitted: boolean };
    expect(r.emitted).toBe(true);
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("expert-horde");
  } finally {
    cleanup();
  }
});

test("hygiene-emit without --project and without --observed-in-task defaults to arc-agents", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "hygiene-emit", "--skill", "clarify-docs",
      "--title", "no observed no project")) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("arc-agents");
  } finally {
    cleanup();
  }
});

test("hygiene-emit inherits project from --observed-in-task row (the regression case)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    // Parent task in a non-arc-agents project
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp",
      "--title", "expert-horde parent", "--project", "expert-horde")) as { id: string };
    // Worker files followup without --project (the broken shape)
    const r = (await run(db, "hygiene-emit", "--skill", "improve-architecture",
      "--title", "expert-horde followup", "--observed-in-task", parent.id)) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("expert-horde");
  } finally {
    cleanup();
  }
});

test("hygiene-emit explicit --project beats --observed-in-task (override wins)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp",
      "--title", "expert-horde parent override", "--project", "expert-horde")) as { id: string };
    const r = (await run(db, "hygiene-emit", "--skill", "clarify-docs",
      "--title", "explicit beats observed",
      "--observed-in-task", parent.id,
      "--project", "arc-agents")) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("arc-agents");
  } finally {
    cleanup();
  }
});

test("hygiene-emit with --observed-in-task pointing at missing row falls back to arc-agents", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "hygiene-emit", "--skill", "clarify-docs",
      "--title", "missing observed", "--observed-in-task", "does-not-exist")) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("arc-agents");
  } finally {
    cleanup();
  }
});

// ── file-path routing beats observed-task inheritance (improve-architecture-route-hygiene-emit-) ──
// A shared-source file (src/ledger/*, bin/ledger.ts) only lives in arc-agents.
// When --body names one, project routes to arc-agents even if the observed
// task is a different project — otherwise bookie's merge guard refuses the PR.

test("hygiene-emit routes to arc-agents when body names a shared-source file, beating observed-task", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp",
      "--title", "arc-skills parent", "--project", "arc-skills")) as { id: string };
    const r = (await run(db, "hygiene-emit", "--skill", "improve-architecture",
      "--title", "fix merge-truth",
      "--body", "the fix lives in src/ledger/merge-truth.ts",
      "--observed-in-task", parent.id)) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("arc-agents");
  } finally {
    cleanup();
  }
});

test("hygiene-emit explicit --project still beats file-path routing", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = (await run(db, "hygiene-emit", "--skill", "improve-architecture",
      "--title", "explicit over route",
      "--body", "touches src/ledger/claim.ts",
      "--project", "arc-skills")) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("arc-skills");
  } finally {
    cleanup();
  }
});

test("hygiene-emit body with no shared-source path still inherits observed-task project", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp",
      "--title", "expert-horde parent 2", "--project", "expert-horde")) as { id: string };
    const r = (await run(db, "hygiene-emit", "--skill", "clarify-docs",
      "--title", "doc drift",
      "--body", "the README wording is stale",
      "--observed-in-task", parent.id)) as { id: string };
    const shown = (await run(db, "show", r.id)) as { issue: { project: string } };
    expect(shown.issue.project).toBe("expert-horde");
  } finally {
    cleanup();
  }
});


// --in-place guard (bin-ledger-ts-restrict-in-place-to-requi) ------------------
// Ghost merges happen when --in-place is used without evidence. The fix:
// (1) --in-place requires --evidence (≤280 chars) so workers explain the no-PR situation.
// (2) --in-place is already mutex with --pr (existing guard).

test("update --in-place refused when --evidence missing (ghost-merge guard)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await stubDiffReview(db, c.id);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/--evidence.*required|--in-place requires --evidence/);
  } finally {
    cleanup();
  }
});

test("update --in-place refused when --evidence exceeds 280 chars", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await stubDiffReview(db, c.id);
    const long = "x".repeat(281);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place", "--evidence", long);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/280/);
  } finally {
    cleanup();
  }
});

test("update --in-place with valid --evidence (≤280) and diff_review succeeds", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await stubDiffReview(db, c.id);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place", "--evidence", "hygiene task, no code change");
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString();
      if (stderr.includes("gh ") || stderr.includes("merge truth")) {
        expect(stderr).not.toMatch(/--evidence.*required/);
        return;
      }
      throw new Error(stderr);
    }
    const shown = (await run(db, "show", c.id)) as { issue: { state: string; evidence_md: string } };
    expect(shown.issue.state).toBe("merged");
    expect(shown.issue.evidence_md).toBe("hygiene task, no code change");
  } finally {
    cleanup();
  }
});

// --- --no-diff (ledger-add-no-diff-no-op-terminal-state-) --------------------
// Hygiene/analysis skills legitimately terminate with zero diff. --no-diff
// skips the diff_review requirement in exchange for mandatory --evidence.

test("update --state merged --no-diff refused without --evidence", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    const r = await runRaw(db, "update", c.id, "--state", "merged", "--no-diff", "--in-place");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/--no-diff requires --evidence|--in-place requires --evidence/);
  } finally {
    cleanup();
  }
});

test("update --state merged --no-diff succeeds without diff_review event", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--no-diff", "--in-place", "--evidence", "N<3 sample, nothing to trash");
    if (r.exitCode !== 0) {
      throw new Error(r.stderr.toString());
    }
    const shown = (await run(db, "show", c.id)) as { issue: { state: string }; events: { kind: string; payload_md: string }[] };
    expect(shown.issue.state).toBe("merged");
    const mergedEvent = shown.events.find((e) => e.kind === "merged");
    expect(mergedEvent?.payload_md).toMatch(/^\[no-diff\]/);
  } finally {
    cleanup();
  }
});

test("update --in-place refused when --pr also supplied (mutex existing guard)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await stubDiffReview(db, c.id);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place", "--pr", "#99", "--evidence", "x");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/mutually exclusive/);
  } finally {
    cleanup();
  }
});

test("update --in-place refused when row's worktree_path no longer exists on disk", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    const nonexistent = "/tmp/this-worktree-does-not-exist-" + Date.now();
    await runStrict(db, "update", c.id, "--worktree", nonexistent);
    await stubDiffReview(db, c.id);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place", "--evidence", "hygiene only");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/no longer exists on disk/);
  } finally {
    cleanup();
  }
});

test("update --in-place succeeds when worktree_path exists on disk", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await runStrict(db, "update", c.id, "--worktree", process.cwd());
    await stubDiffReview(db, c.id);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place", "--evidence", "hygiene task");
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString();
      if (stderr.includes("gh ") || stderr.includes("merge truth")) {
        expect(stderr).not.toMatch(/--evidence.*required/);
        expect(stderr).not.toMatch(/no longer exists on disk/);
        return;
      }
      throw new Error(stderr);
    }
    const shown = (await run(db, "show", c.id)) as { issue: { state: string } };
    expect(shown.issue.state).toBe("merged");
  } finally {
    cleanup();
  }
});

test("update --in-place with no worktree_path set (rows from non-worktree sources) succeeds with evidence", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    await stubDiffReview(db, c.id);
    const r = await runStrictRaw(db, "update", c.id, "--state", "merged", "--in-place", "--evidence", "CLI task, no worktree");
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString();
      if (stderr.includes("gh ") || stderr.includes("merge truth")) {
        expect(stderr).not.toMatch(/--evidence.*required/);
        expect(stderr).not.toMatch(/no longer exists on disk/);
        return;
      }
      throw new Error(stderr);
    }
    const shown = (await run(db, "show", c.id)) as { issue: { state: string } };
    expect(shown.issue.state).toBe("merged");
  } finally {
    cleanup();
  }
});

// Regression: shell interpolation can embed leading/trailing whitespace or
// newlines in the --worktree flag value. Untrimmed whitespace corrupts the
// stored worktree_path, breaking the in-place merge worktree-exists check
// (fix: path-strip, 2026-08-19). The update verb must trim before storing.
test("update --worktree trims leading/trailing whitespace from path", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const c = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "x")) as { id: string };
    // Pass a path with leading/trailing spaces and newlines (simulates shell interpolation artifact).
    const pathWithWhitespace = `  ${process.cwd()}\n`;
    await runStrict(db, "update", c.id, "--worktree", pathWithWhitespace);
    // Fetch the stored value and verify it's trimmed.
    const shown = (await run(db, "show", c.id)) as { issue: { worktree_path: string | null } };
    expect(shown.issue.worktree_path).toBe(process.cwd());
  } finally {
    cleanup();
  }
});

// ── join-status helpers (top-level so all tests can use them) ──────
// `ledger join-status <parent>` is a pure read: no state writes, no
// updated_at bump, no claimed_by clear. It tells a worker (or a human)
// whether the parent is past the dependency barrier and whether every
// blocker landed as a success.

async function forceState(db: string, id: string, state: "merged" | "failed" | "cancelled"): Promise<void> {
  if (state === "merged") {
    await stubDiffReview(db, id);
    await run(db, "update", id, "--state", "merged");
    return;
  }
  await run(db, "update", id, "--state", state);
}

describe("ADR-0013 Wave 3 verb + kind aliases", () => {
  test("ledger issue and ledger ticket both reach the bare-list body (Wave 3 scope)", async () => {
    const { db, cleanup } = freshDb();
    try {
      await run(db, "init");
      await run(db, "create", "--title", "spec-test", "--kind", "prd", "--type", "mvp", "--body", "x");

      // Both verb spellings should return the same row.
      const viaTicket = (await run(db, "ticket")) as Array<{ id: string }>;
      const viaIssue = (await run(db, "issue")) as Array<{ id: string }>;
      expect(viaTicket).toHaveLength(1);
      expect(viaIssue).toEqual(viaTicket);

      // Filter by --kind spec is treated as --kind prd on read-side.
      const viaSpecFilter = (await run(db, "issue", "--kind", "spec")) as Array<{ id: string }>;
      expect(viaSpecFilter).toEqual(viaTicket);

      // Bare `ledger list` works as before (no alias semantics).
      const viaList = (await run(db, "list")) as Array<{ id: string }>;
      expect(viaList).toEqual(viaTicket);
    } finally {
      cleanup();
    }
  });

  test("show emits both ticket + issue keys (dual-key backward compat)", async () => {
    const { db, cleanup } = freshDb();
    try {
      await run(db, "init");
      const created = await run(db, "create", "--title", "dual-key-test", "--kind", "prd", "--type", "mvp", "--body", "x");
      const id = (created as { id: string }).id;

      // Use the canonical "show" verb — `ledger issue show X` falls through to
      // the list body (matches Wave 3 scope; bare-list only for the issue alias).
      const shown = (await run(db, "show", id)) as {
        ticket?: { id: string; state: string };
        issue?: { id: string; state: string };
        events: unknown[];
      };
      expect(shown.ticket).toBeDefined();
      expect(shown.issue).toBeDefined();
      expect(shown.ticket!.id).toBe(id);
      expect(shown.issue!.id).toBe(id);
      // Both keys hold the same row data (structurally equal — JSON parse loses reference identity).
      expect(shown.ticket).toEqual(shown.issue);
    } finally {
      cleanup();
    }
  });

  test("--kind spec on create is translated to prd (write-side symmetry)", async () => {
    const { db, cleanup } = freshDb();
    try {
      await run(db, "init");
      // Without translation this would write kind="spec" and break schema constraint.
      const created = await run(db, "create", "--title", "spec-write", "--kind", "spec", "--type", "mvp", "--body", "x");
      const id = (created as { id: string }).id;

      const shown = (await run(db, "show", id)) as { issue: { kind: string } };
      expect(shown.issue.kind).toBe("prd");
    } finally {
      cleanup();
    }
  });

});

test("join-status: still-blocked parent reports pending blockers, exit 1", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "parent",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = (await run(db, "decompose", parent.id, "--child", "alpha", "--child", "bravo")) as {
      children: { id: string }[];
    };
    // alpha merged, bravo still in progress. The non-sprint cascade
    // keeps the parent blocked until every blocker is merged, so
    // `unblocked=false` and the still-running child is the only pending
    // entry. The merged child is neither pending nor failed.
    await forceState(db, r.children[0]!.id, "merged");

    const out = await runRaw(db, "join-status", parent.id);
    expect(out.exitCode).toBe(1);
    const body = JSON.parse(out.stdout.toString());
    expect(body.id).toBe(parent.id);
    expect(body.state).toBe("blocked");
    expect(body.unblocked).toBe(false);
    expect(body.success).toBe(false);
    expect(body.pending.map((b: { id: string }) => b.id)).toEqual([r.children[1]!.id]);
    expect(body.failed).toEqual([]);
  } finally {
    cleanup();
  }
});

test("join-status: unblocked but failed child → success=false, exit 0", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    // kind=sprint: requeue once all blockers are terminal (merged|failed|cancelled).
    const parent = (await run(db, "create", "--kind", "sprint", "--type", "mvp", "--title", "sprint parent",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = (await run(db, "decompose", parent.id, "--child", "alpha", "--child", "bravo")) as {
      children: { id: string }[];
    };
    await forceState(db, r.children[0]!.id, "merged");
    await forceState(db, r.children[1]!.id, "failed");
    await run(db, "tick");

    const out = await runRaw(db, "join-status", parent.id);
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout.toString());
    expect(body.state).toBe("ready");
    expect(body.unblocked).toBe(true);
    expect(body.success).toBe(false);
    expect(body.failed.map((b: { id: string }) => b.id)).toEqual([r.children[1]!.id]);
  } finally {
    cleanup();
  }
});

test("join-status: all merged → success=true, exit 0", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "sprint", "--type", "mvp", "--title", "sprint all-merged",
      "--tier", "mvp", "--pool", "build")) as { id: string };
    const r = (await run(db, "decompose", parent.id, "--child", "alpha", "--child", "bravo")) as {
      children: { id: string }[];
    };
    for (const c of r.children) await forceState(db, c.id, "merged");
    await run(db, "tick");

    const out = await runRaw(db, "join-status", parent.id);
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout.toString());
    expect(body.unblocked).toBe(true);
    expect(body.success).toBe(true);
    expect(body.pending).toEqual([]);
    expect(body.failed).toEqual([]);
  } finally {
    cleanup();
  }
});

test("join-status: parent with no blocked_by is trivially unblocked", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const parent = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "lone",
      "--tier", "mvp", "--pool", "build")) as { id: string };

    const out = await runRaw(db, "join-status", parent.id);
    expect(out.exitCode).toBe(0);
    const body = JSON.parse(out.stdout.toString());
    expect(body.id).toBe(parent.id);
    expect(body.unblocked).toBe(true);
    expect(body.success).toBe(true);
    expect(body.pending).toEqual([]);
    expect(body.failed).toEqual([]);
  } finally {
    cleanup();
  }
});

test("join-status: missing parent → structured error, exit 2 (distinct from pending)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const out = await runRaw(db, "join-status", "does-not-exist");
    expect(out.exitCode).toBe(2);
    const stderr = out.stderr.toString();
    expect(stderr).toMatch(/no such issue: does-not-exist/);
  } finally {
    cleanup();
  }
});

test("join-status: missing id argument → exit 2", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const out = await runRaw(db, "join-status");
    expect(out.exitCode).toBe(2);
    const stderr = out.stderr.toString();
    expect(stderr).toMatch(/id required/);
  } finally {
    cleanup();
  }
});

test("update: --db before the verb still resolves the id (not the db path)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const created = (await run(db, "create", "--kind", "task", "--type", "mvp", "--title", "t")) as {
      id: string;
    };
    // Global --db precedes the verb here, unlike every other helper in this
    // file which appends --db after args. This is the exact shape that used
    // to misread the db path itself as the ticket id.
    const r =
      await $`bun ${cli} --db ${db} update ${created.id} --evidence done --in-place`
        .env(testEnv)
        .quiet();
    const out = JSON.parse(r.stdout.toString());
    expect(out.id).toBe(created.id);
  } finally {
    cleanup();
  }
});

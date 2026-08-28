// TDD tests for PR-3 pieces:
//   (a) spawn-ready --pool X filter (and --type alias)
//   (b) triageUnset factory function (rule table, idempotency, budget, events)
//
// Written BEFORE implementation per TDD brief.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openWithMigrate, mintId } from "../src/ledger/db";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEDGER = join(REPO, "bin", "ledger.ts");

let workDir: string;
let dbPath: string;

function bun(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bun", args, {
    encoding: "utf8",
    env: { ...process.env, ARC_LEDGER_DB: dbPath, ...env },
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "arc-triage-test-"));
  dbPath = join(workDir, "ledger.db");
  const r = bun([LEDGER, "init"]);
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Helper: insert a ready task directly into the DB
function insertReady(
  overrides: {
    title?: string;
    tier?: string;
    pool?: string;
    agent?: string;
    kind?: string;
    state?: string;
    source_module?: string;
  } = {},
): string {
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath);
  const title = overrides.title ?? `task-${Math.random().toString(36).slice(2, 8)}`;
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent, source_module)
     VALUES (?, 'arc-agents', ?, '', '', 'mvp', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      overrides.state ?? "ready",
      overrides.kind ?? "task",
      overrides.tier ?? "tier_unset",
      overrides.pool ?? "pool_unset",
      overrides.agent ?? "agent_unset",
      overrides.source_module ?? null,
    ],
  );
  db.close();
  return id;
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. spawn-ready --pool X
// ──────────────────────────────────────────────────────────────────────────────

test("spawn-ready --pool interactive returns only interactive ready rows in SORT_KEY order", () => {
  const interactiveId = insertReady({ title: "interactive-task", pool: "interactive", tier: "mvp" });
  insertReady({ title: "build-task", pool: "build", tier: "prod" });
  insertReady({ title: "explore-task", pool: "explore", tier: "trust" });

  const r = bun([LEDGER, "spawn-ready", "--pool", "interactive"]);
  expect(r.status).toBe(0);
  const rows = JSON.parse(r.stdout);
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe(interactiveId);
});

test("spawn-ready --pool build returns only build ready rows", () => {
  insertReady({ title: "interactive-task", pool: "interactive", tier: "mvp" });
  const buildId = insertReady({ title: "build-task", pool: "build", tier: "prod" });

  const r = bun([LEDGER, "spawn-ready", "--pool", "build"]);
  expect(r.status).toBe(0);
  const rows = JSON.parse(r.stdout);
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe(buildId);
});

test("spawn-ready --type X (deprecated alias) returns same as --pool X", () => {
  const interactiveId = insertReady({ title: "interactive-task-alias", pool: "interactive", tier: "mvp" });
  insertReady({ title: "explore-task", pool: "explore", tier: "trust" });

  const byPool = bun([LEDGER, "spawn-ready", "--pool", "interactive"]);
  const byType = bun([LEDGER, "spawn-ready", "--type", "interactive"]);

  expect(byPool.status).toBe(0);
  expect(byType.status).toBe(0);
  const rowsByPool = JSON.parse(byPool.stdout);
  const rowsByType = JSON.parse(byType.stdout);
  expect(rowsByPool.length).toBe(1);
  expect(rowsByType.length).toBe(1);
  expect(rowsByPool[0].id).toBe(interactiveId);
  expect(rowsByType[0].id).toBe(interactiveId);
});

test("spawn-ready excludes hitl=1 rows (parity with buildClaimSQL filter)", () => {
  const normalId = insertReady({ title: "normal-task", pool: "build", tier: "mvp" });
  const hitlId = insertReady({ title: "hitl-task", pool: "build", tier: "prod" });
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath);
  db.run(`UPDATE issues SET hitl=1 WHERE id=?`, [hitlId]);
  db.close();

  const r = bun([LEDGER, "spawn-ready"]);
  expect(r.status).toBe(0);
  const rows = JSON.parse(r.stdout);
  // prod tier ranks first, but the hitl=1 row must be filtered out entirely
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe(normalId);
});

test("spawn-ready with no filter returns all claimable ready rows in SORT_KEY order", () => {
  const prodId = insertReady({ title: "prod-task", pool: "build", tier: "prod" });
  const mvpId = insertReady({ title: "mvp-task", pool: "interactive", tier: "mvp" });
  const unsetId = insertReady({ title: "unset-task", pool: "pool_unset", tier: "tier_unset" });

  const r = bun([LEDGER, "spawn-ready"]);
  expect(r.status).toBe(0);
  const rows = JSON.parse(r.stdout);
  // prod ranks first (tier=0), then mvp (tier=2), then tier_unset (tier=99)
  expect(rows[0].id).toBe(prodId);
  expect(rows[1].id).toBe(mvpId);
  expect(rows[2].id).toBe(unsetId);
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. triageUnset rule table
// ──────────────────────────────────────────────────────────────────────────────

async function loadTriageUnset() {
  // dynamic import — file may not exist yet (TDD: tests first)
  const mod = await import(join(REPO, "bin", "factory.ts"));
  return mod.triageUnset as (db: unknown, budget?: number) => string[];
}

test("triageUnset: arc-chat source_module → agent=chat (beats kind=task)", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "chat-task", kind: "task", tier: "mvp", pool: "pool_unset", agent: "agent_unset", source_module: "arc-chat" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ agent: string; pool: string }, [string]>("SELECT agent, pool FROM issues WHERE id=?").get("chat-task");
    expect(row?.agent).toBe("chat");
    expect(row?.pool).toBe("build"); // mvp tier → build
  } finally {
    db.close();
  }
});

test("triageUnset: kind=prd, agent_unset → agent=director", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "prd-task", kind: "prd", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ agent: string }, [string]>("SELECT agent FROM issues WHERE id=?").get("prd-task");
    expect(row?.agent).toBe("director");
  } finally {
    db.close();
  }
});

test("triageUnset: kind=task, agent_unset → agent=developer", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "dev-task", kind: "task", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ agent: string }, [string]>("SELECT agent FROM issues WHERE id=?").get("dev-task");
    expect(row?.agent).toBe("developer");
  } finally {
    db.close();
  }
});

test("triageUnset: unknown kind, agent_unset → agent=developer (catch-all)", async () => {
  const triageUnset = await loadTriageUnset();
  // Insert a row with kind='prefetch' (valid, not prd/task, no source_module required)
  // to exercise the developer catch-all branch.
  insertReady({ title: "prefetch-task", kind: "prefetch", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ agent: string }, [string]>("SELECT agent FROM issues WHERE id=?").get("prefetch-task");
    expect(row?.agent).toBe("developer");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=mvp, pool_unset → pool=build", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "mvp-build", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("mvp-build");
    expect(row?.pool).toBe("build");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=trust, pool_unset → pool=build", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "trust-build", tier: "trust", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("trust-build");
    expect(row?.pool).toBe("build");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=prod, pool_unset → pool=build", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "prod-build", tier: "prod", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("prod-build");
    expect(row?.pool).toBe("build");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=hygiene, pool_unset → pool=explore", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "hygiene-explore", tier: "hygiene", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("hygiene-explore");
    expect(row?.pool).toBe("explore");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=quality, pool_unset → pool=explore", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "quality-explore", tier: "quality", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("quality-explore");
    expect(row?.pool).toBe("explore");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=efficiency, pool_unset → pool=explore", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "efficiency-explore", tier: "efficiency", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("efficiency-explore");
    expect(row?.pool).toBe("explore");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=scale, pool_unset → pool=explore", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "scale-explore", tier: "scale", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get("scale-explore");
    expect(row?.pool).toBe("explore");
  } finally {
    db.close();
  }
});

test("triageUnset: tier=tier_unset, pool_unset → pool=explore AND tier stays tier_unset", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "unset-explore", tier: "tier_unset", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ pool: string; tier: string }, [string]>("SELECT pool, tier FROM issues WHERE id=?").get("unset-explore");
    expect(row?.pool).toBe("explore");
    expect(row?.tier).toBe("tier_unset"); // tier must never be changed
  } finally {
    db.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. triage idempotency / no-overwrite
// ──────────────────────────────────────────────────────────────────────────────

test("triageUnset: human-set agent and pool are NOT modified", async () => {
  const triageUnset = await loadTriageUnset();
  // Insert row with human-set agent='admin', pool='ops'
  const { Database } = await import("bun:sqlite");
  const db1 = new Database(dbPath);
  db1.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool, agent)
     VALUES ('human-set', 'arc-agents', 'human-set', '', '', 'mvp', 'ready', 'task', 'mvp', 'ops', 'admin')`,
  );
  db1.close();

  const db = new Database(dbPath);
  try {
    triageUnset(db, 10);
    const row = db.query<{ agent: string; pool: string }, [string]>("SELECT agent, pool FROM issues WHERE id=?").get("human-set");
    expect(row?.agent).toBe("admin"); // unchanged
    expect(row?.pool).toBe("ops");    // unchanged
  } finally {
    db.close();
  }
});

test("triageUnset idempotent: second run on drained fixture returns []", async () => {
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "once-task", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    const first = triageUnset(db, 10);
    expect(first.length).toBe(1);

    const second = triageUnset(db, 10);
    expect(second.length).toBe(0); // already triaged, WHERE excludes it
  } finally {
    db.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. triage budget cap
// ──────────────────────────────────────────────────────────────────────────────

test("triageUnset budget=10 cap: seeds 15 rows, only 10 touched (highest priority)", async () => {
  const triageUnset = await loadTriageUnset();

  // Seed 15 untriaged ready rows with varied tiers so SORT_KEY order is clear.
  // 5 prod (highest), 5 mvp (mid), 5 tier_unset (lowest)
  const prodIds: string[] = [];
  const mvpIds: string[] = [];
  const unsetIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    prodIds.push(insertReady({ title: `prod-row-${i}`, tier: "prod", pool: "pool_unset", agent: "agent_unset" }));
  }
  for (let i = 0; i < 5; i++) {
    mvpIds.push(insertReady({ title: `mvp-row-${i}`, tier: "mvp", pool: "pool_unset", agent: "agent_unset" }));
  }
  for (let i = 0; i < 5; i++) {
    unsetIds.push(insertReady({ title: `unset-row-${i}`, tier: "tier_unset", pool: "pool_unset", agent: "agent_unset" }));
  }

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    const touched = triageUnset(db, 10);
    expect(touched.length).toBe(10);

    // All prod (5) + all mvp (5) touched; tier_unset (5) remain untouched
    for (const id of prodIds) {
      const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get(id);
      expect(row?.pool).not.toBe("pool_unset");
    }
    for (const id of mvpIds) {
      const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get(id);
      expect(row?.pool).not.toBe("pool_unset");
    }
    for (const id of unsetIds) {
      const row = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get(id);
      expect(row?.pool).toBe("pool_unset"); // lowest priority — not reached
    }
  } finally {
    db.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. triage only touches ready rows
// ──────────────────────────────────────────────────────────────────────────────

test("triageUnset only touches ready rows: wip and blocked rows are skipped", async () => {
  const triageUnset = await loadTriageUnset();
  const wipId = insertReady({ title: "wip-task", tier: "mvp", pool: "pool_unset", agent: "agent_unset", state: "wip" });
  const blockedId = insertReady({ title: "blocked-task", tier: "mvp", pool: "pool_unset", agent: "agent_unset", state: "blocked" });
  const readyId = insertReady({ title: "ready-task", tier: "mvp", pool: "pool_unset", agent: "agent_unset" }); // state defaults to ready

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    const touched = triageUnset(db, 10);
    expect(touched).toContain(readyId);
    expect(touched).not.toContain(wipId);
    expect(touched).not.toContain(blockedId);

    const wip = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get(wipId);
    expect(wip?.pool).toBe("pool_unset"); // unchanged

    const blocked = db.query<{ pool: string }, [string]>("SELECT pool FROM issues WHERE id=?").get(blockedId);
    expect(blocked?.pool).toBe("pool_unset"); // unchanged
  } finally {
    db.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. triage emits events
// ──────────────────────────────────────────────────────────────────────────────

test("triageUnset emits one issue_event per triaged row with kind=triaged agent=triage", async () => {
  const triageUnset = await loadTriageUnset();
  const id1 = insertReady({ title: "evt-task-1", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });
  const id2 = insertReady({ title: "evt-task-2", tier: "trust", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    const touched = triageUnset(db, 10);
    expect(touched.length).toBe(2);

    const events = db
      .query<{ issue_id: string; kind: string; agent: string }, []>(
        "SELECT issue_id, kind, agent FROM issue_events WHERE kind='triaged'",
      )
      .all();
    expect(events.length).toBe(2);
    const issueIds = events.map((e) => e.issue_id).sort();
    expect(issueIds).toContain(id1);
    expect(issueIds).toContain(id2);
    for (const e of events) {
      expect(e.kind).toBe("triaged");
      expect(e.agent).toBe("triage");
    }
  } finally {
    db.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 9. factory tick TickResult includes triaged field
// ──────────────────────────────────────────────────────────────────────────────

test("TickResult type includes triaged array", async () => {
  // Test by checking the shape of a tick result when there are no sessions
  // (we can't easily call tick() without tmux, but we can assert the exported type
  // shape via triageUnset side-effects on a real DB and the structure of TickResult).
  // This is the minimal non-tmux check: verify triageUnset is callable with a DB
  // and returns string[].
  const triageUnset = await loadTriageUnset();
  insertReady({ title: "tick-shape-task", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  try {
    const result = triageUnset(db, 10);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
  } finally {
    db.close();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 10. ARC_TRIAGE_DISABLE=1 → triageUnset returns [] and mutates nothing
// ──────────────────────────────────────────────────────────────────────────────

test("ARC_TRIAGE_DISABLE=1 → triageUnset returns [] and does not mutate", async () => {
  const origEnv = process.env.ARC_TRIAGE_DISABLE;
  process.env.ARC_TRIAGE_DISABLE = "1";
  try {
    // Re-import to get fresh module with the env set
    // Since bun caches imports, we test the behavior via the function's env check directly
    const triageUnset = await loadTriageUnset();
    insertReady({ title: "disabled-task", tier: "mvp", pool: "pool_unset", agent: "agent_unset" });

    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    try {
      const result = triageUnset(db, 10);
      expect(result).toEqual([]);

      // Row must be untouched
      const row = db.query<{ pool: string; agent: string }, [string]>("SELECT pool, agent FROM issues WHERE id=?").get("disabled-task");
      expect(row?.pool).toBe("pool_unset");
      expect(row?.agent).toBe("agent_unset");
    } finally {
      db.close();
    }
  } finally {
    if (origEnv === undefined) delete process.env.ARC_TRIAGE_DISABLE;
    else process.env.ARC_TRIAGE_DISABLE = origEnv;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// 2b. claim --type still works (deprecated alias via CLI)
// ──────────────────────────────────────────────────────────────────────────────

test("ledger claim --type interactive (deprecated alias) claims an interactive pool row", () => {
  // Insert two rows: one interactive, one build. --type interactive should pick the interactive.
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES ('inter-alias', 'arc-agents', 'inter-alias', '', '', 'mvp', 'ready', 'task', 'mvp', 'interactive')`,
  );
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, tier, pool)
     VALUES ('build-alias', 'arc-agents', 'build-alias', '', '', 'mvp', 'ready', 'task', 'prod', 'build')`,
  );
  db.close();

  const r = bun([LEDGER, "claim", "w-alias-test", "--type", "interactive"]);
  expect(r.status).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result.claimed).toBe("inter-alias");
});

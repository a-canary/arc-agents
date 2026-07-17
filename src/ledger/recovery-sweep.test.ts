// Recovery sweep: read blocked rows whose evidence carries the
// `engine-alias-no-work:<alias>` marker, group by alias, probe each alias,
// and flip the rows back to `ready` on probe success. The probe is a single
// trivial command per alias (rc=0 + non-empty stdout = "alias produces
// work again"). Alias still starved → rows stay blocked, no state change.
// See engine-alias-no-work-recovery-sweep-one-.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { sweepRecovery, sweepMergedPrDesync, type Probe, type RecoverySweepOptions } from "./recovery-sweep";

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function ins(
  db: Database,
  id: string,
  state: string,
  evidence: string | null,
  project: string = "p",
  blocked_by: string | null = null,
): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, evidence_md, type, state, kind, blocked_by)
     VALUES (?, ?, 't', '', ?, 'mvp', ?, 'task', ?)`,
    [id, project, evidence, state, blocked_by],
  );
}

function eventsFor(db: Database, issueId: string, kind?: string): { kind: string; agent: string; payload_md: string }[] {
  const where = kind ? ` AND kind=?` : ``;
  const args: string[] = kind ? [issueId, kind] : [issueId];
  return db
    .query<{ kind: string; agent: string; payload_md: string }, string[]>(
      `SELECT kind, agent, payload_md FROM issue_events WHERE issue_id=?${where} ORDER BY seq ASC`,
    )
    .all(...args);
}

// Stub probe: per-alias result map. Unknown alias = default to rc=0.
function stubProbe(map: Record<string, { rc: number; stdout: string }>): Probe {
  return (cmd: string) => {
    for (const [alias, out] of Object.entries(map)) {
      if (cmd.includes(`alias=${alias}`)) return out;
    }
    return { rc: 0, stdout: "ok" };
  };
}

// Helper to build a probe command that the stub can pattern-match on.
function cmdFor(alias: string, marker: string = "echo"): string {
  return `${marker} alias=${alias}`;
}

test("returns structured salvage handoffs only for review rows", () => {
  const db = setup();
  ins(db, "review-valid", "review", null);
  ins(db, "review-malformed", "review", null);
  ins(db, "merged-valid", "merged", null);
  const valid = JSON.stringify({
    kind: "salvage",
    base: "abc123",
    head: "def456",
    commits: 2,
    branch: "worker/fix",
    exit_code: 124,
    pr_url: "https://github.com/a-canary/arc-agents/pull/9",
    reason: "commits present, no terminal self-report",
  });
  db.run("INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worker-shell', ?)", ["review-valid", valid]);
  db.run("INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worker-shell', ?)", ["review-malformed", '{"kind":"salvage","commits":"2"}']);
  db.run("INSERT INTO issue_events (issue_id, kind, agent, payload_md) VALUES (?, 'note', 'worker-shell', ?)", ["merged-valid", valid]);

  const r = sweepRecovery(db, {
    probe: stubProbe({}),
    commandFor: cmdFor,
    inspectSalvage: () => ({ branchExists: true, headMatches: true, commitsMatch: true, prState: "MERGED" }),
  });

  expect(r.salvage).toEqual([{
    issueId: "review-valid",
    worktreePath: null,
    base: "abc123",
    head: "def456",
    commits: 2,
    branch: "worker/fix",
    exitCode: 124,
    prUrl: "https://github.com/a-canary/arc-agents/pull/9",
    inspection: { branchExists: true, headMatches: true, commitsMatch: true, prState: "MERGED" },
    readyForTerminalUpdate: true,
  }]);
  expect(JSON.parse(eventsFor(db, "review-valid", "note").at(-1)!.payload_md)).toEqual({
    kind: "salvage_inspection",
    branchExists: true,
    headMatches: true,
    commitsMatch: true,
    prState: "MERGED",
    ready_for_terminal_update: true,
  });
  sweepRecovery(db, {
    probe: stubProbe({}), commandFor: cmdFor,
    inspectSalvage: () => ({ branchExists: true, headMatches: true, commitsMatch: true, prState: "MERGED" }),
  });
  expect(eventsFor(db, "review-valid", "note").filter((e) => e.agent === "recovery-sweep")).toHaveLength(1);
});


test("flips only rows whose evidence carries the marker, per-alias", () => {
  const db = setup();
  ins(db, "b1", "blocked", "headless reconcile: ...; engine-alias-no-work:fast");
  ins(db, "b2", "blocked", "headless reconcile: ...; engine-alias-no-work:fast");
  ins(db, "b3", "blocked", "headless reconcile: ...; engine-alias-no-work:smart");
  ins(db, "b4", "blocked", "manually parked for review"); // marker-less, must stay
  ins(db, "b5", "ready", "engine-alias-no-work:fast"); // wrong state, must stay

  const probe = stubProbe({
    fast: { rc: 0, stdout: "ok" },   // recovered
    smart: { rc: 1, stdout: "" },   // still starved
  });
  const r = sweepRecovery(db, {
    now: 1_000_000_000,
    probe,
    commandFor: cmdFor,
  });

  // b1+b2 flipped (fast=ok), b3 stays (smart=starved), b4 skipped (no
  // marker), b5 untouched (not blocked, never fetched).
  expect(r.flipped).toEqual(["b1", "b2"]);
  expect(r.kept).toEqual(["b3"]);
  expect(r.skipped).toEqual(["b4"]);
  expect(r.probes).toEqual([
    { alias: "fast", rc: 0, recovered: true, flipped: 2, kept: 0 },
    { alias: "smart", rc: 1, recovered: false, flipped: 0, kept: 1 },
  ]);
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='b1'").get()?.state).toBe("ready");
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='b2'").get()?.state).toBe("ready");
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='b3'").get()?.state).toBe("blocked");
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='b4'").get()?.state).toBe("blocked");
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='b5'").get()?.state).toBe("ready");
});

test("emits one recovery event per flipped row + one per-alias summary", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast");
  ins(db, "b2", "blocked", "engine-alias-no-work:fast");
  ins(db, "b3", "blocked", "engine-alias-no-work:smart");

  const probe = stubProbe({
    fast: { rc: 0, stdout: "ok" },
    smart: { rc: 0, stdout: "ok" },
  });
  sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });

  // Per-row events
  for (const id of ["b1", "b2", "b3"]) {
    const evs = eventsFor(db, id, "unblocked");
    expect(evs.length).toBe(1);
    expect(evs[0]!.agent).toBe("recovery-sweep");
    expect(evs[0]!.payload_md).toContain("alias=");
  }

  // Summary events: one per distinct alias that produced a probe (regardless
  // of recovered/not — the audit trail should show "we tried X, Y" so a
  // starved alias isn't silent).
  const summaries = db
    .query<{ payload_md: string }, []>(
      `SELECT payload_md FROM issue_events
       WHERE kind='note' AND agent='recovery-sweep'
         AND payload_md LIKE 'recovery-sweep probe:%'
       ORDER BY seq ASC`,
    )
    .all();
  expect(summaries.length).toBe(2);
  expect(summaries[0]!.payload_md).toMatch(/alias=fast/);
  expect(summaries[0]!.payload_md).toMatch(/rc=0/);
  expect(summaries[0]!.payload_md).toMatch(/flipped=2/);
  expect(summaries[1]!.payload_md).toMatch(/alias=smart/);
  expect(summaries[1]!.payload_md).toMatch(/rc=0/);
  expect(summaries[1]!.payload_md).toMatch(/flipped=1/);
});

test("starved alias: rows stay blocked, no flip events, probe event recorded", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast");
  ins(db, "b2", "blocked", "engine-alias-no-work:fast");

  const probe = stubProbe({ fast: { rc: 1, stdout: "" } });
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });

  expect(r.flipped).toEqual([]);
  expect(r.kept).toEqual(["b1", "b2"]);
  for (const id of ["b1", "b2"]) {
    expect(db.query<{ state: string }, [string]>(`SELECT state FROM issues WHERE id=?`).get(id)?.state).toBe("blocked");
    expect(eventsFor(db, id, "unblocked").length).toBe(0);
  }
  // Probe summary still recorded with rc=1, flipped=0
  const summaries = db
    .query<{ payload_md: string }, []>(
      `SELECT payload_md FROM issue_events
       WHERE kind='note' AND agent='recovery-sweep'
         AND payload_md LIKE 'recovery-sweep probe:%'`,
    )
    .all();
  expect(summaries.length).toBe(1);
  expect(summaries[0]!.payload_md).toMatch(/rc=1/);
  expect(summaries[0]!.payload_md).toMatch(/flipped=0/);
});

test("no rows with marker → no probes fired, no events", () => {
  const db = setup();
  ins(db, "b1", "blocked", "manually parked");
  ins(db, "b2", "blocked", "another reason");

  let calls = 0;
  const probe: Probe = (_cmd) => {
    calls++;
    return { rc: 0, stdout: "ok" };
  };
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });

  expect(r.flipped).toEqual([]);
  expect(r.kept).toEqual([]);
  expect(r.skipped.sort()).toEqual(["b1", "b2"]);
  expect(r.probes).toEqual([]);
  expect(calls).toBe(0);
  // No events written
  const all = db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM issue_events`)
    .get();
  expect(all?.n).toBe(0);
});

test("marker extraction: alias name preserves hyphens, underscores, digits", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:minimax-build");
  ins(db, "b2", "blocked", "engine-alias-no-work:fast_alias");
  ins(db, "b3", "blocked", "engine-alias-no-work:arc-2026");

  const probe = stubProbe({
    "minimax-build": { rc: 0, stdout: "ok" },
    fast_alias: { rc: 0, stdout: "ok" },
    "arc-2026": { rc: 0, stdout: "ok" },
  });
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });
  expect(r.flipped.sort()).toEqual(["b1", "b2", "b3"]);
});

test("missing evidence_md is skipped, not flipped", () => {
  const db = setup();
  ins(db, "b1", "blocked", null);
  ins(db, "b2", "blocked", ""); // empty evidence — no marker → skip

  let calls = 0;
  const probe: Probe = (_cmd) => {
    calls++;
    return { rc: 0, stdout: "ok" };
  };
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });

  expect(r.skipped.sort()).toEqual(["b1", "b2"]);
  expect(r.flipped).toEqual([]);
  expect(calls).toBe(0);
});

test("is idempotent: re-running with no new recovery is a no-op", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast");

  const probe = stubProbe({ fast: { rc: 0, stdout: "ok" } });
  sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });
  // After first sweep, b1 is ready — second sweep should be a no-op for b1
  // (it no longer carries the marker in evidence; state is also not blocked).
  const r2 = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });
  expect(r2.flipped).toEqual([]);
  expect(r2.probes).toEqual([]);
});

test("probe invocation receives the commandFor(alias) result verbatim", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast");

  const seen: string[] = [];
  const probe: Probe = (cmd) => {
    seen.push(cmd);
    return { rc: 0, stdout: "ok" };
  };
  sweepRecovery(db, {
    now: 1_000_000_000,
    probe,
    commandFor: (a) => `pi -p alias=${a}`,
  });
  expect(seen).toEqual(["pi -p alias=fast"]);
});

test("default options: now defaults to Date.now()/1000", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast");
  const probe = stubProbe({ fast: { rc: 0, stdout: "ok" } });
  // No now override — should still work
  const r = sweepRecovery(db, { probe, commandFor: cmdFor });
  expect(r.flipped).toEqual(["b1"]);
});

test("rows from multiple projects are handled together (alias is project-agnostic)", () => {
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast", "ke");
  ins(db, "b2", "blocked", "engine-alias-no-work:fast", "arc-agents");
  const probe = stubProbe({ fast: { rc: 0, stdout: "ok" } });
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });
  expect(r.flipped.sort()).toEqual(["b1", "b2"]);
});
test("rows with non-empty blocked_by are skipped even when the alias recovers", () => {
  // Symptom from recovery-sweep-should-not-unblock-rows-w: a row whose
  // engine alias recovered (probe rc=0) was flipped blocked→ready while
  // it still had an unresolved HITL child in blocked_by. Cascade-on-merge
  // is the only legitimate unblock path for a row with pending deps.
  const db = setup();
  ins(db, "b1", "blocked", "engine-alias-no-work:fast", "p", '["hitl-pending"]');
  ins(db, "b2", "blocked", "engine-alias-no-work:fast", "p", null); // normalized '[]' → NULL post-migration
  ins(db, "b3", "blocked", "engine-alias-no-work:fast", "p", '["child-a","child-b"]');

  // Insert the children so the constraint check doesn't fire later.
  ins(db, "hitl-pending", "ready", null, "p", null);
  ins(db, "child-a", "blocked", null, "p", null);
  ins(db, "child-b", "ready", null, "p", null);

  const probe = stubProbe({ fast: { rc: 0, stdout: "ok" } });
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });

  // b1, b3 must stay blocked (real deps pending); b2 flips (NULL blocked_by
  // = post-migration normalize of '[]' or no-deps case). b1/b3 are excluded
  // by the SQL WHERE (blocked_by IS NULL) entirely, so they never reach
  // `skipped` — only child-a (blocked, no marker, NULL blocked_by) does.
  expect(r.flipped).toEqual(["b2"]);
  expect(r.skipped.sort()).toEqual(["child-a"]);
  expect(db.query<{ state: string }, []>(`SELECT state FROM issues WHERE id='b1'`).get()?.state).toBe("blocked");
  expect(db.query<{ state: string }, []>(`SELECT state FROM issues WHERE id='b3'`).get()?.state).toBe("blocked");
  expect(db.query<{ state: string }, []>(`SELECT state FROM issues WHERE id='b2'`).get()?.state).toBe("ready");
  // No probe fired for an alias whose only candidates were skipped
  // (fast in this test had candidates that flipped, so the probe does fire
  // — this test only asserts the per-row outcome).
});

test("rc=0 with empty stdout is NOT recovery — that is the no-work symptom", () => {
  const db = setup();
  ins(db, "e1", "blocked", "engine-alias-no-work:fast");
  const probe = stubProbe({ fast: { rc: 0, stdout: "  \n" } });
  const r = sweepRecovery(db, { now: 1_000_000_000, probe, commandFor: cmdFor });
  expect(r.flipped).toEqual([]);
  expect(r.kept).toEqual(["e1"]);
  expect(r.probes).toEqual([{ alias: "fast", rc: 0, recovered: false, flipped: 0, kept: 1 }]);
  expect(db.query<{ state: string }, []>("SELECT state FROM issues WHERE id='e1'").get()?.state).toBe("blocked");
});

test("sweepMergedPrDesync flags merged rows whose PR is still OPEN on GitHub", () => {
  const db = setup();
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, pr_url)
     VALUES ('m1', 'p', 't', '', 'mvp', 'merged', 'task', 'https://github.com/a/b/pull/8')`,
  );
  db.run(
    `INSERT INTO issues (id, project, title, body_md, type, state, kind, pr_url)
     VALUES ('m2', 'p', 't', '', 'mvp', 'merged', 'task', 'https://github.com/a/b/pull/9')`,
  );
  const prState = (url: string) => (url.endsWith("/8") ? "OPEN" as const : "MERGED" as const);
  const desyncs = sweepMergedPrDesync(db, prState);
  expect(desyncs).toEqual([{ issueId: "m1", prUrl: "https://github.com/a/b/pull/8" }]);
  const events = eventsFor(db, "m1", "note");
  expect(events.length).toBe(1);
  expect(JSON.parse(events[0]!.payload_md)).toMatchObject({ kind: "merged_pr_desync", gh_state: "OPEN" });
  // idempotent: re-running does not duplicate the event
  sweepMergedPrDesync(db, prState);
  expect(eventsFor(db, "m1", "note").length).toBe(1);
});

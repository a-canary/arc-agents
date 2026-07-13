// Recovery sweep: read blocked rows whose evidence carries the
// `engine-alias-no-work:<alias>` marker, group by alias, probe each alias,
// and flip the rows back to `ready` on probe success. The probe is a single
// trivial command per alias (rc=0 + non-empty stdout = "alias produces
// work again"). Alias still starved → rows stay blocked, no state change.
// See engine-alias-no-work-recovery-sweep-one-.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";
import { sweepRecovery, type Probe, type RecoverySweepOptions } from "./recovery-sweep";

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
): void {
  db.run(
    `INSERT INTO issues (id, project, title, body_md, evidence_md, type, state, kind)
     VALUES (?, ?, 't', '', ?, 'mvp', ?, 'task')`,
    [id, project, evidence, state],
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

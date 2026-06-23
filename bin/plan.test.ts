import { describe, expect, it, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PLAN = join(REPO, "bin", "plan.ts");
const LEDGER = join(REPO, "bin", "ledger.ts");
const DB = "/tmp/arc-plan-test.db";

function run(bin: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARC_LEDGER_DB: DB },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function show(id: string): Record<string, unknown> {
  return JSON.parse(run(LEDGER, ["show", id]).out.trim()).issue;
}

beforeEach(() => {
  if (existsSync(DB)) unlinkSync(DB);
  run(LEDGER, ["init"]);
});

describe("plan.ts — emit PRD + tracer-bullet tasks to the approval gate (ADR-0010)", () => {
  it("emits a PRD in state=review with tracer tasks blocked on it", () => {
    const r = run(PLAN, [
      "--project", "arc-webui", "--title", "Ship widget", "--body", "spec body",
      "--tracer", "slice 1", "--tracer", "slice 2",
    ]);
    expect(r.code).toBe(0);
    const { prdId, tracerIds } = JSON.parse(r.out.trim());
    expect(prdId).toBeTruthy();
    expect(tracerIds.length).toBe(2);

    const prd = show(prdId);
    expect(prd.kind).toBe("prd");
    expect(prd.state).toBe("review"); // awaiting the human gate (pendingPrds)
    expect(prd.project).toBe("arc-webui");

    for (const tid of tracerIds) {
      const t = show(tid);
      expect(t.kind).toBe("task");
      expect(t.state).toBe("blocked");
      expect(JSON.parse(t.blocked_by as string)).toEqual([prdId]); // gated on the PRD
    }
  });

  it("approving the PRD releases its tracers to the worker pool (unblock_dependents)", () => {
    const { prdId, tracerIds } = JSON.parse(
      run(PLAN, [
        "--project", "arc-webui", "--title", "Spine test", "--body", "b",
        "--tracer", "s1", "--tracer", "s2",
      ]).out.trim(),
    );
    expect(show(tracerIds[0]).state).toBe("blocked");

    // approve at the gate the way arc-webui's approvePrd does: a direct UPDATE
    // to merged, which fires the canonical unblock_dependents trigger. (The
    // ledger CLI's merged transition is the *code-merge* gate, gated on a
    // diff_review event — a different gate from PRD approval.)
    const db = new Database(DB);
    db.run("UPDATE issues SET state='merged' WHERE id=?", [prdId]);
    db.close();

    expect(show(tracerIds[0]).state).toBe("ready"); // claimable by bg-worker pool
    expect(show(tracerIds[1]).state).toBe("ready");
  });

  it("rejects missing --title or no --tracer", () => {
    expect(run(PLAN, ["--project", "arc-webui", "--tracer", "x"]).code).not.toBe(0);
    expect(run(PLAN, ["--project", "arc-webui", "--title", "y"]).code).not.toBe(0);
  });
});

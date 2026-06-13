import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshDb(): { db: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-fu-"));
  const db = join(dir, "t.db");
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(db: string, ...args: string[]): Promise<unknown> {
  const r = await $`bun ${cli} ${args} --db ${db}`.quiet();
  return JSON.parse(r.stdout.toString());
}

const ANALYSIS = `# Analysis: expert-horde Recent Sessions

## Recommended follow-up rows to file

| Priority | Title (slug) | Type | Notes | LOC |
|---|---|---|---|---|
| P1 (Critical) | \`expert-horde-merge-pr8-json-extract-ema\` | quality (or HITL if merger lacks scope) | \`gh pr merge 8 --squash\` after re-verifying. | \u22645 |
| P1 (Critical) | \`expert-horde-delete-stranded-3761a98-branch\` | quality | \`git push origin :worker/000059...\`. | \u22645 |
| P2 (High) | \`analyse-recent-sessions-auto-file-followups\` | quality | Re-files 8 prior follow-ups in one shot. | \u226430 |
`;

test("followup-emit: parses analysis file and emits N ready rows with tier=quality kind=task", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const analysisPath = join(tmpdir(), `analysis-${Date.now()}.md`);
    writeFileSync(analysisPath, ANALYSIS);
    const result = (await run(db, "followup-emit", "--analysis", analysisPath, "--observed-in-task", "test-123")) as {
      emitted: number;
      rows: Array<{ id: string; title: string; type: string }>;
    };
    expect(result.emitted).toBe(3);
    expect(result.rows.map((r) => r.title)).toEqual([
      "expert-horde-merge-pr8-json-extract-ema",
      "expert-horde-delete-stranded-3761a98-branch",
      "analyse-recent-sessions-auto-file-followups",
    ]);
    // First row was typed "quality (or HITL if merger lacks scope)" — should resolve to quality
    expect(result.rows[0]!.type).toBe("quality");

    // Verify ledger state: 3 ready rows, tier=quality, kind=task
    const list = (await run(db, "list", "--all")) as Array<{ id: string; state: string; kind: string; type: string; title: string }>;
    expect(list.length).toBe(3);
    for (const r of list) {
      expect(r.state).toBe("ready");
      expect(r.kind).toBe("task");
      expect(r.type).toBe("quality");
    }
  } finally {
    cleanup();
  }
});

test("followup-emit: errors when --analysis path is unreadable", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const r = await $`bun ${cli} followup-emit --analysis /nope/does-not-exist.md --db ${db}`.quiet().nothrow();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("cannot read --analysis");
  } finally {
    cleanup();
  }
});

test("followup-emit: errors when file has no follow-up table", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const path = join(tmpdir(), `analysis-no-table-${Date.now()}.md`);
    writeFileSync(path, "# Analysis\n\nNo table here.\n");
    const r = await $`bun ${cli} followup-emit --analysis ${path} --db ${db}`.quiet().nothrow();
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("no follow-up table parsed");
  } finally {
    cleanup();
  }
});

test("followup-emit: emitted row body references the analysis source", async () => {
  const { db, cleanup } = freshDb();
  try {
    await run(db, "init");
    const path = join(tmpdir(), `analysis-body-${Date.now()}.md`);
    writeFileSync(path, ANALYSIS);
    await run(db, "followup-emit", "--analysis", path, "--observed-in-task", "parent-task-id");
    const show = (await run(db, "show", "expert-horde-merge-pr8-json-extract-ema")) as {
      issue: { body_md: string };
    };
    expect(show.issue.body_md).toContain("gh pr merge 8");
    expect(show.issue.body_md).toContain("Source:");
    expect(show.issue.body_md).toContain(path);
    expect(show.issue.body_md).toContain("parent-task-id");
  } finally {
    cleanup();
  }
});

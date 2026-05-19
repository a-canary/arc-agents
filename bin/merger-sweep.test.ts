import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./merger-sweep.ts", import.meta.url).pathname;

let dir: string;
let binDir: string;

// Fixture of gh pr list output covering every action partition.
//
// PR numbers map to expected actions:
//   101 ready          — MERGEABLE, CI green, not draft, old enough
//   102 hitl_conflict  — CONFLICTING
//   103 defer          — UNKNOWN mergeable state
//   104 hitl_author    — author-lint divergence (headRefName signals bot/external)
//   105 hitl_scope     — slice-guard fail signaled via labels
//   106 hitl_ambiguous — REVIEW_REQUIRED + CI green (signal conflict)
//   107 skip           — draft
//   108 skip           — too young (createdAt < 5min ago)
const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1hr old
const TOO_YOUNG_ISO = new Date(Date.now() - 60 * 1000).toISOString(); // 1min old

const FIXTURE = [
  {
    number: 101,
    headRefName: "feat/ready-clean",
    createdAt: OLD_ISO,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }],
    labels: [],
    author: { login: "a-canary" },
  },
  {
    number: 102,
    headRefName: "feat/has-conflicts",
    createdAt: OLD_ISO,
    isDraft: false,
    mergeable: "CONFLICTING",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    labels: [],
    author: { login: "a-canary" },
  },
  {
    number: 103,
    headRefName: "feat/unknown-state",
    createdAt: OLD_ISO,
    isDraft: false,
    mergeable: "UNKNOWN",
    reviewDecision: null,
    statusCheckRollup: [],
    labels: [],
    author: { login: "a-canary" },
  },
  {
    number: 104,
    headRefName: "feat/author-divergence",
    createdAt: OLD_ISO,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    labels: ["author-lint:divergent"],
    author: { login: "external-bot" },
  },
  {
    number: 105,
    headRefName: "feat/over-scope",
    createdAt: OLD_ISO,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    labels: ["slice-guard:fail"],
    author: { login: "a-canary" },
  },
  {
    number: 106,
    headRefName: "feat/needs-review",
    createdAt: OLD_ISO,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    labels: [],
    author: { login: "a-canary" },
  },
  {
    number: 107,
    headRefName: "feat/draft",
    createdAt: OLD_ISO,
    isDraft: true,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    labels: [],
    author: { login: "a-canary" },
  },
  {
    number: 108,
    headRefName: "feat/just-opened",
    createdAt: TOO_YOUNG_ISO,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    labels: [],
    author: { login: "a-canary" },
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "merger-sweep-"));
  binDir = join(dir, "bin");
  mkdirSync(binDir);
  // Stub `gh` on PATH — echo the fixture JSON regardless of args.
  const stub = `#!/usr/bin/env bash
cat <<'JSON'
${JSON.stringify(FIXTURE)}
JSON
`;
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function sweep(args: string[] = []) {
  return await $`bun ${cli} ${args}`
    .env({ ...process.env, PATH: `${binDir}:${process.env.PATH}` })
    .quiet()
    .nothrow();
}

function parseLines(stdout: string): Array<{ pr: number; action: string; reason: string }> {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test("emits one JSON line per PR with pr, action, reason", async () => {
  const r = await sweep();
  expect(r.exitCode).toBe(0);
  const rows = parseLines(r.stdout.toString());
  expect(rows.length).toBe(FIXTURE.length);
  for (const row of rows) {
    expect(typeof row.pr).toBe("number");
    expect(typeof row.action).toBe("string");
    expect(typeof row.reason).toBe("string");
  }
});

test("partitions MERGEABLE + CI green + approved + old as action=ready", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const ready = rows.find((x) => x.pr === 101)!;
  expect(ready.action).toBe("ready");
});

test("partitions CONFLICTING as action=hitl_conflict", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 102)!;
  expect(row.action).toBe("hitl_conflict");
});

test("partitions UNKNOWN mergeable as action=defer", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 103)!;
  expect(row.action).toBe("defer");
});

test("partitions author-lint:divergent label as action=hitl_author", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 104)!;
  expect(row.action).toBe("hitl_author");
});

test("partitions slice-guard:fail label as action=hitl_scope", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 105)!;
  expect(row.action).toBe("hitl_scope");
});

test("partitions REVIEW_REQUIRED + CI green (signal conflict) as action=hitl_ambiguous", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 106)!;
  expect(row.action).toBe("hitl_ambiguous");
});

test("partitions draft PRs as action=skip", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 107)!;
  expect(row.action).toBe("skip");
});

test("partitions too-young MERGEABLE PRs as action=skip (age < 5min)", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const row = rows.find((x) => x.pr === 108)!;
  expect(row.action).toBe("skip");
});

test("--dry-run is the default behavior and exits 0", async () => {
  const r = await sweep();
  expect(r.exitCode).toBe(0);
  // Dry-run only prints JSON lines, no side-effects implied.
  const stdout = r.stdout.toString();
  expect(stdout).toContain('"pr":101');
});

test("explicit --dry-run produces same output as default", async () => {
  const a = await sweep();
  const b = await sweep(["--dry-run"]);
  expect(b.exitCode).toBe(0);
  expect(parseLines(b.stdout.toString())).toEqual(parseLines(a.stdout.toString()));
});

test("ready PRs include a one-line invocation hint in reason", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const ready = rows.find((x) => x.pr === 101)!;
  expect(ready.action).toBe("ready");
  // The hint must mention the merger so a human reader knows the next step.
  expect(ready.reason.toLowerCase()).toContain("merger");
});

test("hitl_* reasons describe what a human is being asked", async () => {
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  for (const row of rows) {
    if (row.action.startsWith("hitl_")) {
      expect(row.reason.length).toBeGreaterThan(0);
    }
  }
});

test("does not emit a HITL prompt per MERGEABLE PR — only on hitl_* partitions", async () => {
  // The whole point of the doctrine: HITL is rare. Of 8 PRs in fixture,
  // exactly 4 belong to hitl_* (conflict, author, scope, ambiguous).
  const r = await sweep();
  const rows = parseLines(r.stdout.toString());
  const hitl = rows.filter((x) => x.action.startsWith("hitl_"));
  expect(hitl.length).toBe(4);
});

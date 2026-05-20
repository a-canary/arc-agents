import { test, expect } from "bun:test";
import { $ } from "bun";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

function freshTrash(): { root: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vacuum-trash-"));
  return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(root: string, ...extra: string[]): Promise<any> {
  const args = ["vacuum-trash", "--root", root, ...extra];
  const r = await $`bun ${cli} ${args}`.quiet();
  return JSON.parse(r.stdout.toString());
}

function writeTtlPair(
  root: string,
  batch: string,
  payloadName: string,
  sweepAfter: string,
  extra: Record<string, string> = {},
): { payload: string; sidecar: string } {
  const dir = join(root, batch);
  mkdirSync(dir, { recursive: true });
  const payload = join(dir, payloadName);
  const sidecar = `${payload}.ttl`;
  writeFileSync(payload, "payload contents\n");
  const fields = {
    retired_at: "2026-04-01T00:00:00Z",
    retired_by: "tester",
    origin_path: `repo/${payloadName}`,
    origin_repo: "arc-agents",
    origin_sha: "deadbeef",
    ledger_row: "test-row",
    sweep_after: sweepAfter,
    reason: "test fixture",
    ...extra,
  };
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(sidecar, body + "\n");
  return { payload, sidecar };
}

test("dry-run lists due entries without deleting", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const due = writeTtlPair(root, "1700000000_old-2026-04-01", "stale.md", "20260430");
    const fresh = writeTtlPair(root, "1700000001_new-2026-05-01", "young.md", "20260601");
    const r = await run(root, "--now", "20260520");
    expect(r.apply).toBe(false);
    expect(r.due).toHaveLength(1);
    expect(r.due[0].sidecar).toBe(due.sidecar);
    expect(r.deleted).toEqual([]);
    expect(existsSync(due.payload)).toBe(true);
    expect(existsSync(due.sidecar)).toBe(true);
    expect(existsSync(fresh.payload)).toBe(true);
    expect(existsSync(fresh.sidecar)).toBe(true);
  } finally {
    cleanup();
  }
});

test("--apply deletes paired payload + sidecar past sweep_after", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const due = writeTtlPair(root, "1700000000_old-2026-04-01", "stale.md", "20260430");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.apply).toBe(true);
    expect(r.deleted).toContain(due.payload);
    expect(r.deleted).toContain(due.sidecar);
    expect(existsSync(due.payload)).toBe(false);
    expect(existsSync(due.sidecar)).toBe(false);
  } finally {
    cleanup();
  }
});

test("files within 30d window are preserved", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const fresh = writeTtlPair(root, "1700000001_recent-2026-05-01", "young.md", "20260601");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.due).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(existsSync(fresh.payload)).toBe(true);
    expect(existsSync(fresh.sidecar)).toBe(true);
  } finally {
    cleanup();
  }
});

test("idempotent: re-run after apply is a no-op", async () => {
  const { root, cleanup } = freshTrash();
  try {
    writeTtlPair(root, "1700000000_old-2026-04-01", "stale.md", "20260430");
    await run(root, "--now", "20260520", "--apply");
    const r2 = await run(root, "--now", "20260520", "--apply");
    expect(r2.due).toEqual([]);
    expect(r2.deleted).toEqual([]);
  } finally {
    cleanup();
  }
});

test("empties batch directory is rmdir'd after sweep", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const due = writeTtlPair(root, "1700000000_old-2026-04-01", "stale.md", "20260430");
    const batchDir = join(root, "1700000000_old-2026-04-01");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.emptied).toContain(batchDir);
    expect(existsSync(batchDir)).toBe(false);
    expect(existsSync(due.payload)).toBe(false);
  } finally {
    cleanup();
  }
});

test("non-empty batch (mixed due + fresh) is kept; only due files removed", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const batch = "1700000000_mixed-2026-04-01";
    const dueOne = writeTtlPair(root, batch, "stale.md", "20260430");
    const freshOne = writeTtlPair(root, batch, "young.md", "20260601");
    const batchDir = join(root, batch);
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.deleted).toContain(dueOne.payload);
    expect(r.deleted).toContain(dueOne.sidecar);
    expect(r.deleted).not.toContain(freshOne.payload);
    expect(existsSync(batchDir)).toBe(true);
    expect(existsSync(freshOne.payload)).toBe(true);
    expect(existsSync(freshOne.sidecar)).toBe(true);
  } finally {
    cleanup();
  }
});

test("sidecar with missing payload is skipped, not error", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const batchDir = join(root, "1700000000_orphan-2026-04-01");
    mkdirSync(batchDir, { recursive: true });
    const sidecar = join(batchDir, "ghost.md.ttl");
    writeFileSync(sidecar, "sweep_after: 20260430\norigin_path: gone\n");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.due).toEqual([]);
    expect(r.skipped.some((s: any) => s.path === sidecar && s.reason === "paired payload missing")).toBe(true);
    expect(existsSync(sidecar)).toBe(true);
  } finally {
    cleanup();
  }
});

test("sidecar with missing sweep_after field is skipped", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const batchDir = join(root, "1700000000_malformed-2026-04-01");
    mkdirSync(batchDir, { recursive: true });
    const payload = join(batchDir, "broken.md");
    const sidecar = `${payload}.ttl`;
    writeFileSync(payload, "x");
    writeFileSync(sidecar, "origin_path: foo\nreason: malformed\n");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.due).toEqual([]);
    expect(existsSync(payload)).toBe(true);
    expect(existsSync(sidecar)).toBe(true);
  } finally {
    cleanup();
  }
});

test("symlink escape: sidecar pointing outside root is not followed", async () => {
  const { root, cleanup } = freshTrash();
  const outside = mkdtempSync(join(tmpdir(), "vacuum-outside-"));
  try {
    const victim = join(outside, "do-not-touch.md");
    writeFileSync(victim, "precious\n");
    const batchDir = join(root, "1700000000_attack-2026-04-01");
    mkdirSync(batchDir, { recursive: true });
    const linkPayload = join(batchDir, "do-not-touch.md");
    symlinkSync(victim, linkPayload);
    const sidecar = `${linkPayload}.ttl`;
    writeFileSync(sidecar, "sweep_after: 20260430\norigin_path: x\n");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.due).toEqual([]);
    expect(existsSync(victim)).toBe(true);
    expect(r.skipped.some((s: any) => s.reason.includes("escapes trash root"))).toBe(true);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("invalid --now is rejected", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const r = await $`bun ${cli} vacuum-trash --root ${root} --now not-a-date`.quiet().nothrow();
    expect(r.exitCode).not.toBe(0);
  } finally {
    cleanup();
  }
});

test("missing trash root reports gracefully (no crash)", async () => {
  const missing = join(tmpdir(), `vacuum-missing-${Date.now()}`);
  const r = await $`bun ${cli} vacuum-trash --root ${missing}`.quiet();
  const parsed = JSON.parse(r.stdout.toString());
  expect(parsed.note).toBe("root not found");
  expect(parsed.due).toEqual([]);
});

test("equal date boundary: today == sweep_after preserves file", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const same = writeTtlPair(root, "1700000000_boundary-2026-05-20", "edge.md", "20260520");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.due).toEqual([]);
    expect(existsSync(same.payload)).toBe(true);
  } finally {
    cleanup();
  }
});

test("day after sweep_after deletes file", async () => {
  const { root, cleanup } = freshTrash();
  try {
    const due = writeTtlPair(root, "1700000000_oneday-2026-05-19", "tip.md", "20260519");
    const r = await run(root, "--now", "20260520", "--apply");
    expect(r.deleted).toContain(due.payload);
    expect(existsSync(due.payload)).toBe(false);
  } finally {
    cleanup();
  }
});

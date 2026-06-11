// E2E: trash-sweep against a temp dir, both dry-run and --apply modes.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./trash-sweep.ts", import.meta.url).pathname;

let dir: string;
let trashDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trash-sweep-"));
  trashDir = join(dir, "trash");
  mkdirSync(trashDir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function sweep(args: string[] = []) {
  return await $`bun ${cli} ${args} --dir ${trashDir}`.quiet().nothrow();
}

function makeBatch(name: string, day: string, files: { name: string; ttl: string | null }[]) {
  const batchDir = join(trashDir, `${name}-${day}`);
  mkdirSync(batchDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(batchDir, f.name), `body of ${f.name}`);
    if (f.ttl !== null) {
      writeFileSync(join(batchDir, f.name + ".ttl"), f.ttl);
    }
  }
  return batchDir;
}

const TTL_PAST = `retired_at: 2026-04-01T00:00:00Z
retired_by: a-canary
origin_path: foo/bar.ts
origin_repo: arc-agents
origin_sha: abc1234
ledger_row: hygiene-foo
sweep_after: 20260501
reason: dead
`;

const TTL_FUTURE = `retired_at: 2026-06-01T00:00:00Z
retired_by: a-canary
origin_path: baz/qux.ts
origin_repo: arc-agents
origin_sha: def5678
ledger_row: hygiene-baz
sweep_after: 20260701
reason: wip
`;

test("dry-run (default) reports a file past sweep_after as swept but does not delete it", async () => {
  const batch = makeBatch("111_retire-1", "20260301", [
    { name: "old.ts", ttl: TTL_PAST },
  ]);
  const r = await sweep();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.applied).toBe(false);
  expect(out.swept_count).toBe(1);
  expect(out.swept[0].path).toBe(join(batch, "old.ts"));
  expect(out.swept[0].sweep_after).toBe("20260501");
  // File still on disk in dry-run mode
  expect(existsSync(join(batch, "old.ts"))).toBe(true);
  expect(existsSync(join(batch, "old.ts.ttl"))).toBe(true);
});

test("--apply actually deletes the file, its .ttl sidecar, and the empty batch dir", async () => {
  const batch = makeBatch("222_retire-2", "20260301", [
    { name: "old.ts", ttl: TTL_PAST },
  ]);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.applied).toBe(true);
  expect(out.swept_count).toBe(1);
  expect(existsSync(join(batch, "old.ts"))).toBe(false);
  expect(existsSync(join(batch, "old.ts.ttl"))).toBe(false);
  expect(existsSync(batch)).toBe(false);
});

test("files with sweep_after in the future are kept (not swept) even with --apply", async () => {
  const batch = makeBatch("333_retire-3", "20260601", [
    { name: "young.ts", ttl: TTL_FUTURE },
  ]);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(0);
  expect(out.kept_count).toBe(1);
  expect(out.kept[0].reason).toMatch(/sweep_after/);
  expect(existsSync(join(batch, "young.ts"))).toBe(true);
});

test("files with no .ttl sidecar are kept and reported as 'no .ttl sidecar'", async () => {
  const batch = makeBatch("444_retire-4", "20260301", [
    { name: "legacy.ts", ttl: null },
  ]);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(0);
  expect(out.kept_count).toBe(1);
  expect(out.kept[0].reason).toBe("no .ttl sidecar");
  expect(existsSync(join(batch, "legacy.ts"))).toBe(true);
});

test("files with malformed .ttl are kept and reported as 'malformed .ttl'", async () => {
  const batch = makeBatch("555_retire-5", "20260301", [
    { name: "broken.ts", ttl: "this is not yaml, just garbage" },
  ]);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(0);
  expect(out.kept[0].reason).toBe("malformed .ttl");
  expect(existsSync(join(batch, "broken.ts"))).toBe(true);
});

test("mixed batch: only past-sweep_after files are deleted; future ones remain", async () => {
  const batch = makeBatch("666_retire-6", "20260301", [
    { name: "old.ts", ttl: TTL_PAST },
    { name: "young.ts", ttl: TTL_FUTURE },
  ]);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(1);
  expect(out.kept_count).toBe(1);
  expect(out.swept[0].path).toMatch(/old\.ts$/);
  expect(out.kept[0].path).toMatch(/young\.ts$/);
  expect(existsSync(join(batch, "old.ts"))).toBe(false);
  expect(existsSync(join(batch, "young.ts"))).toBe(true);
  // Batch dir is NOT removed because young.ts is still in it
  expect(existsSync(batch)).toBe(true);
});

test("top-level loose files (not in a dated dir) are ignored", async () => {
  writeFileSync(join(trashDir, "stray.md"), "stray");
  const r = await sweep();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(0);
  expect(out.kept_count).toBe(0);
  expect(existsSync(join(trashDir, "stray.md"))).toBe(true);
});

test("non-conforming batch dir names (no <ts>_<name>-<YYYYMMDD> shape) are skipped", async () => {
  const weirdDir = join(trashDir, "notadatedir");
  mkdirSync(weirdDir, { recursive: true });
  writeFileSync(join(weirdDir, "x.ts"), "x");
  writeFileSync(join(weirdDir, "x.ts.ttl"), TTL_PAST);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(0);
  expect(existsSync(join(weirdDir, "x.ts"))).toBe(true);
});

test("swept entries expose origin_path/origin_repo/origin_sha for audit", async () => {
  const batch = makeBatch("777_retire-7", "20260301", [
    { name: "audited.ts", ttl: TTL_PAST },
  ]);
  const r = await sweep(["--apply"]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept[0]).toMatchObject({
    origin_path: "foo/bar.ts",
    origin_repo: "arc-agents",
    origin_sha: "abc1234",
    sweep_after: "20260501",
  });
});

test("missing trash dir is a no-op (exit 0) with a note in the output", async () => {
  rmSync(trashDir, { recursive: true, force: true });
  const r = await sweep();
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout.toString());
  expect(out.swept_count).toBe(0);
  expect(out.error).toMatch(/trash dir not found/);
});

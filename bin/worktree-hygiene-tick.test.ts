import { test, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bug this locks: the cron used to run the main checkout's WORKING TREE,
// so whatever branch it was parked on (plus uncommitted edits) became what
// production executed overnight. The wrapper must run COMMITTED code from a
// pinned ref instead. Each test dirties the source checkout in the way that
// actually happened, and asserts the sweep did not see it.

const tick = new URL("./worktree-hygiene-tick.sh", import.meta.url).pathname;

let dir: string;
let srcRepo: string;
let pinned: string;

// Stand-in for bin/worktree-hygiene.ts: prints the marker committed at the ref,
// so the test can tell which copy of the scanner ran.
const scanner = (marker: string) => `console.log(${JSON.stringify(marker)});\n`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wt-hygiene-tick-"));
  srcRepo = join(dir, "src-repo");
  pinned = join(dir, "pinned");
  mkdirSync(join(srcRepo, "bin", "cron"), { recursive: true });

  await $`git init -q -b main ${srcRepo}`.quiet();
  await $`git -C ${srcRepo} config user.email t@t.t`.quiet();
  await $`git -C ${srcRepo} config user.name t`.quiet();

  // The wrapper + preamble must live in the source repo's bin/, since the
  // wrapper resolves SRC_REPO relative to its own path.
  for (const f of ["worktree-hygiene-tick.sh", "cron-preamble.sh", "report-error.sh"]) {
    const from = new URL(`./${f}`, import.meta.url).pathname;
    try {
      writeFileSync(join(srcRepo, "bin", f), readFileSync(from));
    } catch {
      writeFileSync(join(srcRepo, "bin", f), "#!/usr/bin/env bash\n");
    }
    await $`chmod +x ${join(srcRepo, "bin", f)}`.quiet();
  }

  writeFileSync(join(srcRepo, "bin", "worktree-hygiene.ts"), scanner("COMMITTED"));
  await $`git -C ${srcRepo} add -A`.quiet();
  await $`git -C ${srcRepo} commit -qm init`.quiet();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (ref: string, ...args: string[]) =>
  $`${join(srcRepo, "bin", "worktree-hygiene-tick.sh")} ${args}`
    .env({
      ...process.env,
      ARC_HYGIENE_REF: ref,
      ARC_HYGIENE_CHECKOUT: pinned,
      BUN: process.execPath,
    })
    .nothrow()
    .quiet();

test("runs committed code, not uncommitted edits in the source checkout", async () => {
  // The exact production failure: someone edits the scanner in the main
  // checkout and never commits. The sweep must not pick it up.
  writeFileSync(join(srcRepo, "bin", "worktree-hygiene.ts"), scanner("UNCOMMITTED-EDIT"));

  const r = await run("main");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("COMMITTED");
  expect(r.stdout.toString()).not.toContain("UNCOMMITTED-EDIT");
});

test("ignores whatever branch the source checkout is parked on", async () => {
  // 2026-09-11: the checkout sat on a feature branch, so the cron ran that
  // branch's stale scanner. Pinned to main, the parked branch is irrelevant.
  await $`git -C ${srcRepo} checkout -qb worker/parked`.quiet();
  writeFileSync(join(srcRepo, "bin", "worktree-hygiene.ts"), scanner("PARKED-BRANCH"));
  await $`git -C ${srcRepo} commit -qam parked`.quiet();

  const r = await run("main");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("COMMITTED");
  expect(r.stdout.toString()).not.toContain("PARKED-BRANCH");
});

test("picks up new commits on the pinned ref each tick", async () => {
  // Pinning must not mean frozen: a merged fix has to reach production without
  // re-provisioning the checkout.
  expect((await run("main")).stdout.toString()).toContain("COMMITTED");

  writeFileSync(join(srcRepo, "bin", "worktree-hygiene.ts"), scanner("FIX-LANDED"));
  await $`git -C ${srcRepo} commit -qam fix`.quiet();

  expect((await run("main")).stdout.toString()).toContain("FIX-LANDED");
});

test("fails loud when the ref has no scanner, instead of silently no-opping", async () => {
  // Pinning to a ref without bin/worktree-hygiene.ts (e.g. main today) must
  // not exit 0 quietly — that recreates the 'nobody noticed' failure mode.
  await $`git -C ${srcRepo} rm -q bin/worktree-hygiene.ts`.quiet();
  await $`git -C ${srcRepo} commit -qm "drop scanner"`.quiet();

  const r = await run("main");
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("fix ARC_HYGIENE_REF");
});

test("--ref-check verifies the pin without running the scanner", async () => {
  // I filed 10 real ledger rows by running the wrapper with a --dry-run flag
  // the scanner does not implement — it ignored the unknown arg and swept for
  // real. --ref-check is the safe way to verify a ref, so it must resolve the
  // pin and then NOT invoke the scanner.
  const r = await run("main", "--ref-check");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("ref-check OK");
  expect(r.stdout.toString()).not.toContain("COMMITTED");
});

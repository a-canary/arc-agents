// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// lint-migrations.test.ts — G-0007 enforcement lint
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "lint-migrations.sh");

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-mig-"));
  mkdirSync(join(dir, "src/ledger"), { recursive: true });
  return dir;
}

function run(project: string) {
  return spawnSync("bash", [SCRIPT, "--project", project], { encoding: "utf8" });
}

describe("lint-migrations.sh", () => {
  let project: string;
  beforeEach(() => { project = makeProject(); });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  test("exits 0 on clean migrate.ts", () => {
    writeFileSync(join(project, "src/ledger/migrate.ts"), "export function migrate() { /* no symlinks here */ }\n");
    const r = run(project);
    expect(r.status).toBe(0);
  });

  test("exits 1 on symlinkSync hit", () => {
    writeFileSync(join(project, "src/ledger/migrate.ts"), "import { symlinkSync } from 'node:fs';\nsymlinkSync('a','b');\n");
    const r = run(project);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("G-0007");
  });

  test("exits 1 on symlink( hit", () => {
    writeFileSync(join(project, "src/ledger/migrate.ts"), "await fs.symlink('a','b');\n");
    const r = run(project);
    expect(r.status).toBe(1);
  });

  test("exits 1 on ln -s in migration sql", () => {
    mkdirSync(join(project, "src/ledger/migrations"), { recursive: true });
    writeFileSync(join(project, "src/ledger/migrate.ts"), "// clean\n");
    writeFileSync(join(project, "src/ledger/migrations/001.sql"), "-- ln -s old new\n");
    const r = run(project);
    expect(r.status).toBe(1);
  });

  test("exits 0 when no migration files exist", () => {
    const r = run(project);
    expect(r.status).toBe(0);
  });
});

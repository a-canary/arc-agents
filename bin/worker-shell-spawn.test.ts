// acquire_workspace() tests — treehouse spawn.sh wiring (replaces the
// deprecated G-0004 raw `git worktree add` path; arc-director CHOICES.md
// 2026-08-19). Sources the real script with ARC_WORKER_SHELL_SOURCE_ONLY=1
// (same harness as the other worker-shell-*.test.ts files) so the helper
// under test is the one production runs, not a copy.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Drive acquire_workspace against a fake spawn.sh at the given path. Returns
// { rc, stdout }.
function callAcquire(spawnSh: string): { rc: number; stdout: string } {
	const r = spawnSync(
		"bash",
		["-c", `source "$0" && acquire_workspace /tmp/fake-repo fake-slug fake-holder`, SCRIPT],
		{
			encoding: "utf8",
			env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1", ARC_SPAWN_SH: spawnSh },
		},
	);
	return { rc: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
}

function fakeSpawn(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "wshell-spawn-"));
	const p = join(dir, "spawn.sh");
	writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
	return p;
}

test("passes through spawn.sh JSON on success", () => {
	const fake = fakeSpawn(`echo '{"path":"/wt","branch":"worker/fake-slug","base_sha":"abc123"}'`);
	const { rc, stdout } = callAcquire(fake);
	expect(rc).toBe(0);
	expect(JSON.parse(stdout)).toEqual({ path: "/wt", branch: "worker/fake-slug", base_sha: "abc123" });
	rmSync(join(dirname(fake)), { recursive: true, force: true });
});

test("propagates stale-base exit 3 (retriable, lease already released)", () => {
	const fake = fakeSpawn(`echo "stale" >&2; exit 3`);
	const { rc } = callAcquire(fake);
	expect(rc).toBe(3);
	rmSync(join(dirname(fake)), { recursive: true, force: true });
});

test("collapses other spawn.sh failures (usage/env/pool) to 4", () => {
	const fake = fakeSpawn(`echo "treehouse not on PATH" >&2; exit 2`);
	const { rc } = callAcquire(fake);
	expect(rc).toBe(4);
	rmSync(join(dirname(fake)), { recursive: true, force: true });
});

test("missing spawn.sh → 4 (no default checkout on this host)", () => {
	const { rc } = callAcquire("/nonexistent/arc-director/src/driver/scripts/spawn.sh");
	expect(rc).toBe(4);
});

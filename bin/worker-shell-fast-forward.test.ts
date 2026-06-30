// fast_forward_main() tests — pre-claim local main fast-forward.
//
// Pattern 3 / Pattern 4 follow-up of analysis-1782813826.md: rows that claim
// against a repo whose local `main` is N commits behind `origin/main` see a
// stale parent, so `--local-merged-sha` truth-checks (merge-guard) and the
// worktree base branch (worker/card-...) drift from the canonical remote. The
// 000103 follow-up `fast-forward-local-main-after-merge` was never filed; this
// is the slice: fast-forward local main to origin/main BEFORE we add the
// per-claim worktree, in worker-shell.sh.
//
// Why here, not a cron: a cron fires at most every N minutes, so any claim
// between ticks still sees the stale base. The first claim-after-merge is also
// the most fragile (the merge was just pushed; the next worker picks up the
// seam). Doing it in worker-shell.sh removes the cause.
//
// We source the real script with ARC_WORKER_SHELL_SOURCE_ONLY=1 (same harness
// as the other worker-shell-*.test.ts files) so the helper under test is the
// one production runs, not a copy.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "worker-shell.sh");

// Drive the pure helper against the given repo path. Captures stdout/stderr;
// expects the helper to return 0 on fast-forward, 1 on a fatal git error
// (no-remote, true conflict). Returns { rc, stdout, stderr }.
function callFf(repo: string, env: Record<string, string> = {}): {
	rc: number;
	stdout: string;
	stderr: string;
} {
	const r = spawnSync(
		"bash",
		["-c", `source "$0" && fast_forward_main "$1"`, SCRIPT, repo],
		{
			encoding: "utf8",
			env: { ...process.env, ARC_WORKER_SHELL_SOURCE_ONLY: "1", ...env },
		},
	);
	return {
		rc: r.status ?? -1,
		stdout: (r.stdout ?? "").trim(),
		stderr: (r.stderr ?? "").trim(),
	};
}

// Build a throwaway git repo with an `origin` remote, then put local `main`
// N commits behind origin/main by adding N commits on the remote side after
// the shared base (initial + N extra empty commits on the origin clone; local
// refs the same initial commit so it sits exactly N behind).
function repoBehindOrigin(behindBy: number): string {
	const dir = mkdtempSync(join(tmpdir(), "wshell-ff-"));
	const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
	run(`git init -q -b main`);
	run(`git config user.email t@t && git config user.name t`);
	run(`git commit -q --allow-empty -m init`);
	// Build a separate clone as `origin` from this initial state.
	const origin = mkdtempSync(join(tmpdir(), "wshell-ff-origin-"));
	run(`git clone -q "${dir}" "${origin}"`);
	// Advance the remote ONLY (origin clone) by `behindBy` extra commits.
	for (let i = 0; i < behindBy; i++) {
		execSync(`git -C "${origin}" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "remote-${i}"`, {
			stdio: "pipe",
		});
	}
	// Wire local repo's `origin` to the remote clone so `origin/main` is fetchable.
	run(`git remote add origin "${origin}"`);
	run(`git fetch -q origin`);
	// Sanity: local main should now be exactly N behind origin/main.
	run(`git config user.email t@t && git config user.name t`);
	process.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
			rmSync(origin, { recursive: true, force: true });
		} catch {}
	});
	return dir;
}

// Core invariant: behind-by-N local repo → after fast_forward_main, local main
// === origin/main AND helper returns 0. This is the regression guard for the
// `analysis-1782813826.md` Pattern 3 follow-up.
test("fast_forward_main advances local main to origin/main when N commits behind", () => {
	const repo = repoBehindOrigin(3);
	const r = callFf(repo);
	expect(r.rc).toBe(0);
	const local = execSync(`git -C "${repo}" rev-parse main`, {
		encoding: "utf8",
	}).trim();
	const remote = execSync(`git -C "${repo}" rev-parse origin/main`, {
		encoding: "utf8",
	}).trim();
	expect(local).toBe(remote);
});

test("fast_forward_main is a no-op (rc=0) when local main already equals origin/main", () => {
	const dir = mkdtempSync(join(tmpdir(), "wshell-ff-clean-"));
	const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
	run(`git init -q -b main`);
	run(`git config user.email t@t && git config user.name t`);
	run(`git commit -q --allow-empty -m init`);
	// No remote at all (no `git remote add`) — the helper must tolerate this
	// and still return 0, because a worker claiming against a same-host
	// non-cloned repo is still valid; we just don't ff. (Helper's "no remote"
	// path returns 1, which is *not* fatal for the caller — see call site.)
	// Actually: there's a difference between "no remote configured" and
	// "remote configured but unreachable". This test pins the ALL-CLEAR
	// path: local already matches origin/main → 0 + no refs changed.
	const origin = mkdtempSync(join(tmpdir(), "wshell-ff-clean-origin-"));
	run(`git clone -q "${dir}" "${origin}"`);
	run(`git remote add origin "${origin}"`);
	const r = callFf(dir);
	expect(r.rc).toBe(0);
	const local = execSync(`git -C "${dir}" rev-parse main`, {
		encoding: "utf8",
	}).trim();
	const remote = execSync(`git -C "${dir}" rev-parse origin/main`, {
		encoding: "utf8",
	}).trim();
	expect(local).toBe(remote);
	process.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
			rmSync(origin, { recursive: true, force: true });
		} catch {}
	});
});

test("fast_forward_main returns non-zero when there is no `origin` remote configured", () => {
	const dir = mkdtempSync(join(tmpdir(), "wshell-ff-noremote-"));
	const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
	run(`git init -q -b main`);
	run(`git config user.email t@t && git config user.name t`);
	run(`git commit -q --allow-empty -m init`);
	const r = callFf(dir);
	// Caller treats non-zero as "skip ff, continue" — see the call site comment.
	expect(r.rc).not.toBe(0);
	process.on("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
});

test("fast_forward_main on a non-existent path fails closed (non-zero)", () => {
	const r = callFf("/no/such/path/exists/here");
	expect(r.rc).not.toBe(0);
});

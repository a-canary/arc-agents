// ADR-0014 `inspect` — resolve claimed_by → live tmux session (identity
// match, naming arc-worker-a-<workerid>), capture pane tail.
// Exit 0 live session captured · 1 no live session · 2 id not found.
// Uses a fake `tmux` on PATH; liveness is driven by FAKE_TMUX_LIVE file.

import { test, expect } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("./ledger.ts", import.meta.url).pathname;

const FAKE_TMUX = `#!/bin/sh
case "$1" in
  has-session)
    s=""
    while [ $# -gt 0 ]; do
      case "$1" in -t) s="$2";; esac
      shift
    done
    grep -qx "$s" "\${FAKE_TMUX_LIVE}" 2>/dev/null && exit 0 || exit 1
    ;;
  capture-pane)
    echo "fake-pane-line-1"
    echo "fake-pane-line-2"
    exit 0
    ;;
esac
exit 1
`;

// Fresh temp dir + db + fake tmux on PATH. liveSessions = sessions for which
// `tmux has-session` succeeds.
function fixture(liveSessions: string[]): { db: string; env: Record<string, string>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-inspect-"));
  const db = join(dir, "t.db");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tmuxPath = join(bin, "tmux");
  writeFileSync(tmuxPath, FAKE_TMUX);
  chmodSync(tmuxPath, 0o755);
  const liveFile = join(dir, "live-sessions");
  writeFileSync(liveFile, liveSessions.join("\n") + (liveSessions.length ? "\n" : ""));
  const env: Record<string, string> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_TMUX_LIVE: liveFile };
  return { db, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(f: { db: string; env: Record<string, string> }, ...args: string[]) {
  return await $`bun ${cli} ${args} --db ${f.db}`.env(f.env).quiet().nothrow();
}

async function firstId(f: { db: string; env: Record<string, string> }, state: string): Promise<string> {
  const rows = JSON.parse((await run(f, "list", "--state", state)).stdout.toString()) as { id: string }[];
  return rows[0]!.id;
}

test("inspect: missing id exits 2 with stderr", async () => {
  const f = fixture([]);
  try {
    await run(f, "init");
    const r = await run(f, "inspect", "no-such-row-xyz");
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("no such issue");
  } finally { f.cleanup(); }
});

test("inspect: unclaimed row exits 1 with live:false", async () => {
  const f = fixture([]);
  try {
    await run(f, "init");
    await run(f, "create", "--kind", "task", "--type", "mvp", "--title", "inspect unclaimed");
    const id = await firstId(f, "ready");
    const r = await run(f, "inspect", id);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout.toString()) as { live: boolean };
    expect(out.live).toBe(false);
  } finally { f.cleanup(); }
});

test("inspect: claimed row with dead session exits 1 naming the session", async () => {
  const f = fixture([]); // no live sessions
  try {
    await run(f, "init");
    await run(f, "create", "--kind", "task", "--type", "mvp", "--title", "inspect dead session");
    await run(f, "claim", "arc-worker-a-dead1");
    const id = await firstId(f, "claimed");
    const r = await run(f, "inspect", id);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout.toString()) as { live: boolean; session: string };
    expect(out.live).toBe(false);
    expect(out.session).toBe("arc-worker-a-dead1");
  } finally { f.cleanup(); }
});

test("inspect: live session exits 0 with captured lines", async () => {
  const f = fixture(["arc-worker-a-live1"]);
  try {
    await run(f, "init");
    await run(f, "create", "--kind", "task", "--type", "mvp", "--title", "inspect live session");
    await run(f, "claim", "arc-worker-a-live1");
    const id = await firstId(f, "claimed");

    const r = await run(f, "inspect", id);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { live: boolean; session: string; lines: string[] };
    expect(out.live).toBe(true);
    expect(out.session).toBe("arc-worker-a-live1");
    expect(out.lines).toContain("fake-pane-line-1");
  } finally { f.cleanup(); }
});

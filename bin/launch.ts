#!/usr/bin/env bun
// arc-agents launcher. Interviewer-only tmux session "arc":
//   pane 0: interviewer  (no /loop; user-driven chat → ledger writes via bookie)
//
// Workers are no longer panes here — they are ephemeral tmux sessions spawned by bin/factory.ts.
// See CHOICES.md M-0004 (supersedes M-0002's long-lived worker panes).
//
// `bun bin/launch.ts` creates session (if absent) and attaches. Idempotent.
// `bun bin/launch.ts --kill` tears it down.

import { spawnSync } from "node:child_process";

const SESSION = process.env.ARC_TMUX ?? "arc";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

function tmux(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function sessionExists(): boolean {
  return tmux("has-session", "-t", SESSION).ok;
}

function run(): void {
  if (process.argv.includes("--kill")) {
    if (sessionExists()) tmux("kill-session", "-t", SESSION);
    return;
  }
  if (sessionExists()) {
    if (process.stdout.isTTY) tmux("attach-session", "-t", SESSION);
    else console.log(JSON.stringify({ session: SESSION, attached: false, reason: "already running" }));
    return;
  }
  const r = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", SESSION, "-n", "arc", "-x", "220", "-y", "60"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  tmux("select-pane", "-t", `${SESSION}:0.0`, "-T", "interviewer");
  tmux("send-keys", "-t", `${SESSION}:0.0`, CLAUDE, "Enter");
  tmux("set-option", "-t", SESSION, "pane-border-status", "top");
  if (process.stdout.isTTY) tmux("attach-session", "-t", SESSION);
  else console.log(JSON.stringify({ session: SESSION, panes: 1, attached: process.stdout.isTTY }));
}

if (import.meta.main) run();

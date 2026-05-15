#!/usr/bin/env bun
// arc-agents pane launcher. 4-pane tmux session "arc":
//   pane 0: interviewer  (no /loop; user-driven chat → ledger writes via bookie)
//   pane 1: developer    (/loop 5m + wait-for-ledger --role developer)
//   pane 2: specialist   (/loop 5m + wait-for-ledger --role developer; second worker)
//   pane 3: admin        (/loop 5m + wait-for-ledger --role admin)
//
// `bun bin/launch.ts` creates session (if absent) and attaches. Idempotent.
// `bun bin/launch.ts --kill` tears it down.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SESSION = process.env.ARC_TMUX ?? "arc";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const WAITER = join(REPO, "bin", "wait-for-ledger.ts");
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

type Pane = { role: "interviewer" | "developer" | "admin"; loop: boolean; title: string };

const PANES: Pane[] = [
  { role: "interviewer", loop: false, title: "interviewer" },
  { role: "developer", loop: true, title: "developer" },
  { role: "developer", loop: true, title: "specialist" },
  { role: "admin", loop: true, title: "admin" },
];

function tmux(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function sessionExists(): boolean {
  return tmux("has-session", "-t", SESSION).ok;
}

function paneCommand(p: Pane): string {
  if (p.role === "interviewer") return `${CLAUDE}`;
  const role = p.role === "admin" ? "admin" : "developer";
  const waiterFile = `/tmp/arc-waiter-${p.title}.jsonl`;
  // Waiter writes edge-trigger JSON to a file (not the tty, so it never becomes pane input).
  // /loop prompt tells claude to Monitor that file each tick — wakes on ledger edge, /loop 5m is fallback heartbeat.
  const waiterCmd = `nohup bun ${WAITER} --role ${role} >${waiterFile} 2>/dev/null &`;
  const loopPrompt = `/loop 5m Monitor ${waiterFile} for new lines; on each wake claim one ready ${role} task (\`bun ${join(REPO, "bin", "ledger.ts")} claim ${role} ${p.title}\`), execute in a worktree, commit as a-canary, update ledger state=merged with evidence; if no task claimable, exit quietly`;
  return `${waiterCmd} ${CLAUDE} --append-system-prompt 'role=${p.role}; arc-agents worker; autonomous AFK; commit as a-canary' "${loopPrompt}"`;
}

export function buildScript(): string[] {
  const cmds: string[][] = [];
  cmds.push(["new-session", "-d", "-s", SESSION, "-n", "arc", "-x", "220", "-y", "60"]);
  for (let i = 1; i < PANES.length; i++) {
    cmds.push(["split-window", "-t", `${SESSION}:0`]);
    cmds.push(["select-layout", "-t", `${SESSION}:0`, "tiled"]);
  }
  PANES.forEach((p, i) => {
    cmds.push(["select-pane", "-t", `${SESSION}:0.${i}`, "-T", p.title]);
    cmds.push(["send-keys", "-t", `${SESSION}:0.${i}`, paneCommand(p), "Enter"]);
  });
  cmds.push(["set-option", "-t", SESSION, "pane-border-status", "top"]);
  return cmds.map((c) => c.join(" "));
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
  const r = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-n", "arc", "-x", "220", "-y", "60"], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  for (let i = 1; i < PANES.length; i++) {
    tmux("split-window", "-t", `${SESSION}:0`);
    tmux("select-layout", "-t", `${SESSION}:0`, "tiled");
  }
  PANES.forEach((p, i) => {
    tmux("select-pane", "-t", `${SESSION}:0.${i}`, "-T", p.title);
    tmux("send-keys", "-t", `${SESSION}:0.${i}`, paneCommand(p), "Enter");
  });
  tmux("set-option", "-t", SESSION, "pane-border-status", "top");
  if (process.stdout.isTTY) tmux("attach-session", "-t", SESSION);
  else console.log(JSON.stringify({ session: SESSION, panes: PANES.length, attached: process.stdout.isTTY }));
}

if (import.meta.main) run();

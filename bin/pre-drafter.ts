#!/usr/bin/env bun
// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

// S8 — pre-drafter CLI entry.
//
//   bun bin/pre-drafter.ts run [--once] [--interval-sec N] [--db PATH]
//
// Single-pass or polling loop. Gated by ARC_PREDRAFTER_ENABLED=1 (no-op when
// unset) so the scaffold can land before S5's HITL panel consumes draft_md.

import { openWithMigrate } from "../src/ledger/db";
import { runPreDrafter } from "../src/interviewer/pre-drafter";

function getFlag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = args[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return args[i + 1];
}

const args = process.argv.slice(2);
const cmd = args[0] ?? "run";

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  process.stdout.write(
    `pre-drafter — S8 interviewer pre-drafter loop\n\n` +
      `usage: bun bin/pre-drafter.ts run [--once] [--interval-sec N] [--db PATH]\n\n` +
      `env: ARC_PREDRAFTER_ENABLED=1 required (no-op otherwise)\n`,
  );
  process.exit(0);
}

if (cmd !== "run") {
  process.stderr.write(`pre-drafter: unknown command '${cmd}'\n`);
  process.exit(2);
}

if (process.env.ARC_PREDRAFTER_ENABLED !== "1") {
  process.stdout.write("pre-drafter: disabled (set ARC_PREDRAFTER_ENABLED=1)\n");
  process.exit(0);
}

const once = args.includes("--once");
const intervalSec = parseInt(getFlag(args, "interval-sec") ?? "30", 10);
const dbPath = getFlag(args, "db") ?? process.env.ARC_LEDGER_DB;
const db = openWithMigrate(dbPath);

function tick(): void {
  const r = runPreDrafter(db);
  if (r.generated.length || r.cleared.length) {
    process.stdout.write(
      JSON.stringify({
        ts: Math.floor(Date.now() / 1000),
        generated: r.generated,
        cleared: r.cleared,
        unchanged_count: r.unchanged.length,
      }) + "\n",
    );
  }
}

tick();
if (once) process.exit(0);

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

(async () => {
  while (!stopping) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    if (stopping) break;
    try { tick(); } catch (e) {
      process.stderr.write(`pre-drafter tick error: ${(e as Error).message}\n`);
    }
  }
  process.exit(0);
})();
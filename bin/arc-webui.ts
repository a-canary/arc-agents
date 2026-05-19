#!/usr/bin/env bun
// arc-webui — UX module (ADR 0006). Pusher + thin web entrypoint.
//
// Verbs:
//   push           drain pending deliveries for module='webui'; transition
//                  rows to delivered/failed/skipped via shared pusher.
//   serve [port]   stub HTTP server. POST /webhook ingests a session reply
//                  and forwards to `arc-ux event --module webui
//                  --external-ref <session-id>` (verb is forward-referenced;
//                  call is logged today, wired when arc-ux event lands).
//
// Real SSE/WebSocket transport is the SvelteKit slice (see PRD-arc-webui.md).
// The deliver callback today returns delivered with no external_ref so the
// pusher state-machine is exercisable end-to-end against fixtures.

import { spawnSync } from "child_process";
import { open } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { push, type DeliverFn, type PushResult } from "../src/arc-ux/pusher";

export const MODULE = "webui";

export const deliver: DeliverFn = async (_row) => {
  // TODO: push to live webui session; fill external_ref with session msg id.
  return { status: "delivered" };
};

export async function runPush(): Promise<PushResult> {
  const db = open();
  migrate(db);
  return push(db, MODULE, deliver);
}

export function ingestWebhook(body: { sessionId: string; text?: string }): {
  ok: boolean;
  forwarded: string[];
} {
  // arc-ux `event` verb is forward-referenced (see task body). Until it
  // lands, capture the intended invocation so the contract is visible.
  const argv = [
    "event",
    "--module",
    MODULE,
    "--external-ref",
    body.sessionId,
    ...(body.text ? ["--text", body.text] : []),
  ];
  // Don't actually spawn — verb doesn't exist yet. Returning the argv lets
  // the test pin the contract.
  return { ok: true, forwarded: argv };
}

async function serve(port: number) {
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/webhook") {
        return req.json().then((body: any) => {
          const r = ingestWebhook(body);
          return new Response(JSON.stringify(r), {
            headers: { "content-type": "application/json" },
          });
        });
      }
      return new Response("arc-webui", { status: 200 });
    },
  });
  console.log(JSON.stringify({ listening: port }));
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "push") {
    const r = await runPush();
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "serve") {
    const port = Number(process.argv[3] ?? 5174);
    await serve(port);
    return;
  }
  console.error("usage: arc-webui <push|serve [port]>");
  process.exit(2);
}

// Avoid auto-running under bun test.
if (import.meta.path === Bun.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// silence unused import in non-serve paths
void spawnSync;

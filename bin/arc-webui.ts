#!/usr/bin/env bun
// arc-webui — UX module skeleton (ADR 0006).
//
// Verbs:
//   push    drain pending deliveries for module=arc-webui; transition each
//           to delivered/failed/skipped via the shared pusher contract.
//
// Stub: the SvelteKit webui transport is not implemented yet. The deliver
// callback is a no-op until the SSE/poll endpoint lands.

import { open } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { push, type DeliverFn } from "../src/arc-ux/pusher";

const MODULE = "arc-webui";

const deliver: DeliverFn = async (_row) => {
  // TODO: deliver to webui session; return { status: "delivered", external_ref: <session msg id> }
  return { status: "delivered" };
};

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "push") {
    console.error("usage: arc-webui push");
    process.exit(2);
  }
  const db = open();
  migrate(db);
  const r = await push(db, MODULE, deliver);
  console.log(JSON.stringify(r));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env bun
// arc-discord — UX module skeleton (ADR 0006).
//
// Verbs:
//   push    drain pending deliveries for module=arc-discord; transition each
//           to delivered/failed/skipped via the shared pusher contract.
//
// This is a stub: the actual Discord transport is not implemented yet. The
// `deliver` callback below is a no-op that returns `delivered` so the state
// machine can be exercised end-to-end. Wire a real Discord client when the
// transport lands.

import { open } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { push, type DeliverFn } from "../src/arc-ux/pusher";

const MODULE = "arc-discord";

const deliver: DeliverFn = async (_row) => {
  // TODO: send to Discord; return { status: "delivered", external_ref: <msg id> }
  // For now act as a successful no-op so the contract is observable.
  return { status: "delivered" };
};

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "push") {
    console.error("usage: arc-discord push");
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

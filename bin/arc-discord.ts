#!/usr/bin/env bun
// arc-discord — UX module pusher (ADR 0006).
//
// Verbs:
//   push   drain deliveries WHERE state='pending' AND module='arc-discord';
//          transition each to delivered/failed/skipped via the shared
//          pusher contract (src/arc-ux/pusher.ts).
//
// Credentials: Discord bot token is read from the `pass` store
// (key: arc-agents/discord/bot-token). NEVER from environment variables —
// env-var creds are the wrong trust boundary for AFK workers (CHOICES /
// task acceptance).
//
// Webhook ingress (separate process, not implemented here): a Discord
// gateway/webhook listener translates inbound messages into ledger events
// via `arc-ux event --module arc-discord --external-ref <channel-id> ...`.
// That verb is out of scope for this scaffold.

import { spawnSync } from "node:child_process";
import { open } from "../src/ledger/db";
import { migrate } from "../src/ledger/migrate";
import { push, type DeliverFn, type PendingDelivery } from "../src/arc-ux/pusher";

export const MODULE = "arc-discord";
const TOKEN_PASS_KEY = "arc-agents/discord/bot-token";
const DISCORD_API = "https://discord.com/api/v10";

export function readBotToken(passKey: string = TOKEN_PASS_KEY): string {
  const r = spawnSync("pass", ["show", passKey], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`pass show ${passKey} failed: ${r.stderr?.trim() ?? "no stderr"}`);
  }
  const tok = (r.stdout ?? "").split("\n")[0]!.trim();
  if (!tok) throw new Error(`pass show ${passKey} returned empty token`);
  return tok;
}

export type DiscordPoster = (channelId: string, body: string) => Promise<{ id: string }>;

export function makeHttpPoster(token: string): DiscordPoster {
  return async (channelId, body) => {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "authorization": `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: body }),
    });
    if (!res.ok) {
      throw new Error(`discord POST ${channelId} ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as { id: string };
    return { id: j.id };
  };
}

// Render the deliverable's body. Reply/hitl_prompt body lives on the
// `issues` row referenced by target_id. Pulled out so tests can stub.
export function loadRenderable(
  db: { query: (sql: string) => { get: (id: string) => { body_md: string } | null } },
  targetId: string,
): string {
  const row = db.query(`SELECT body_md FROM issues WHERE id=?`).get(targetId);
  return row?.body_md ?? "";
}

export function makeDeliver(post: DiscordPoster, dbHandle: any): DeliverFn {
  return async (row: PendingDelivery) => {
    const channelId = row.external_ref;
    if (!channelId) return { status: "failed", error: "no external_ref (channel id)" };
    const body = loadRenderable(dbHandle, row.target_id);
    if (!body) return { status: "skipped" };
    const { id } = await post(channelId, body);
    return { status: "delivered", external_ref: id };
  };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "push") {
    console.error("usage: arc-discord push");
    process.exit(2);
  }
  const db = open();
  migrate(db);
  const token = readBotToken();
  const post = makeHttpPoster(token);
  const deliver = makeDeliver(post, db);
  const r = await push(db, MODULE, deliver);
  console.log(JSON.stringify(r));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

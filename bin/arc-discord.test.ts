import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/ledger/migrate";
import { fanout } from "../src/arc-ux/deliveries";
import { push } from "../src/arc-ux/pusher";
import { MODULE, makeDeliver, type DiscordPoster } from "./arc-discord";
import { readFileSync } from "node:fs";

function fresh(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.run(
    `INSERT INTO issues (id, project, title, body_md, acceptance_md, type, state, kind, class, urgency, source_module, thread_id)
     VALUES ('reply-1', 'test', 't', 'hello world', '', 'mvp', 'ready', 'reply', 'MVP', 'nominal', 'arc-chat', 'thr-1')`,
  );
  return db;
}

function sub(db: Database, mod: string, ch: string, state: "active" | "muted" | "archived" = "active") {
  db.run(
    `INSERT INTO thread_subscriptions (thread_id, module, external_ref, state) VALUES (?, ?, ?, ?)`,
    ["thr-1", mod, ch, state],
  );
}

function rows(db: Database) {
  return db
    .query<{ state: string; external_ref: string | null; error: string | null }, [string]>(
      `SELECT state, external_ref, error FROM deliveries WHERE module=? ORDER BY id`,
    )
    .all(MODULE);
}

test("pending → delivered with discord message id as external_ref", async () => {
  const db = fresh();
  sub(db, MODULE, "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const post: DiscordPoster = async (ch, body) => {
    expect(ch).toBe("ch-A");
    expect(body).toBe("hello world");
    return { id: "msg-7" };
  };

  const r = await push(db, MODULE, makeDeliver(post, db));
  expect(r).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  const got = rows(db);
  expect(got[0]!.state).toBe("delivered");
  expect(got[0]!.external_ref).toBe("msg-7");
});

test("pending → failed when discord post throws", async () => {
  const db = fresh();
  sub(db, MODULE, "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const post: DiscordPoster = async () => {
    throw new Error("rate limited");
  };

  const r = await push(db, MODULE, makeDeliver(post, db));
  expect(r).toEqual({ delivered: 0, failed: 1, skipped: 0 });
  const got = rows(db);
  expect(got[0]!.state).toBe("failed");
  expect(got[0]!.error).toBe("rate limited");
});

test("pending → skipped when subscription muted post-fanout", async () => {
  const db = fresh();
  sub(db, MODULE, "ch-A");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });
  // Mute after fanout so a pending delivery exists for the pusher to skip.
  db.run(`UPDATE thread_subscriptions SET state='muted' WHERE module=? AND external_ref=?`, [MODULE, "ch-A"]);

  const post: DiscordPoster = async () => {
    throw new Error("should not be called when muted");
  };

  const r = await push(db, MODULE, makeDeliver(post, db));
  expect(r).toEqual({ delivered: 0, failed: 0, skipped: 1 });
  expect(rows(db)[0]!.state).toBe("skipped");
});

test("pending → failed when delivery has no external_ref (channel id)", async () => {
  const db = fresh();
  // Subscription with empty external_ref → fanout writes empty ref into delivery row.
  sub(db, MODULE, "");
  fanout(db, { target_kind: "reply", target_id: "reply-1", thread_id: "thr-1" });

  const post: DiscordPoster = async () => ({ id: "should-not-happen" });
  const r = await push(db, MODULE, makeDeliver(post, db));
  expect(r.failed).toBe(1);
  expect(rows(db)[0]!.error).toContain("no external_ref");
});

test("no env-var credentials referenced in source", () => {
  const src = readFileSync(new URL("./arc-discord.ts", import.meta.url), "utf8");
  // Forbid process.env reads for any *TOKEN* / *SECRET* style credential.
  expect(/process\.env\.[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD)/i.test(src)).toBe(false);
  // Affirm pass-based credential read is wired.
  expect(src).toContain("pass");
  expect(src).toContain("arc-agents/discord/bot-token");
});

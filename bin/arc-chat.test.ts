import { describe, expect, it, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync, existsSync } from "node:fs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT = join(REPO, "bin", "arc-chat.ts");
const LEDGER = join(REPO, "bin", "ledger.ts");
const DB = "/tmp/arc-chat-test.db";

function run(bin: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ARC_LEDGER_DB: DB },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

beforeEach(() => {
  if (existsSync(DB)) unlinkSync(DB);
  run(LEDGER, ["init"]);
});

describe("arc-chat post", () => {
  it("mints a new thread id when none given", () => {
    const r = run(CHAT, ["post", "hello world"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.thread_id).toMatch(/^t-/);
    expect(parsed.id).toBeTruthy();
  });

  it("reuses an explicit thread id", () => {
    const t = "t-fixed-abcd";
    const r = run(CHAT, ["post", "hi", "--thread", t]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim()).thread_id).toBe(t);
  });

  it("creates a chat_in/interactive ready row", () => {
    run(CHAT, ["post", "ping", "--thread", "t-x"]);
    const lst = run(LEDGER, ["list", "--kind", "chat_in"]);
    expect(lst.out).toContain("interactive");
    expect(lst.out).toContain("ready");
  });
});

describe("arc-chat tail --once", () => {
  it("returns empty when no chat_out exists", () => {
    const r = run(CHAT, ["tail", "--thread", "t-empty", "--once"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("");
  });

  it("emits chat_out rows for the thread", () => {
    run(LEDGER, [
      "create", "--kind", "chat_out", "--type", "interactive",
      "--title", "reply text", "--body", "reply text full", "--thread", "t-y",
    ]);
    const r = run(CHAT, ["tail", "--thread", "t-y", "--once"]);
    expect(r.code).toBe(0);
    const line = JSON.parse(r.out.trim());
    expect(line.body).toBe("reply text full");
  });
});

describe("arc-chat threads", () => {
  it("lists threads ordered by recency with turn counts", () => {
    run(CHAT, ["post", "first", "--thread", "t-a"]);
    run(CHAT, ["post", "second", "--thread", "t-a"]);
    run(CHAT, ["post", "other", "--thread", "t-b"]);
    const r = run(CHAT, ["threads"]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
    const ta = lines.find((l) => l.thread_id === "t-a");
    expect(ta?.turns).toBe(2);
  });
});

describe("render-prompt thread replay", () => {
  it("includes prior chat turns in the rendered prompt", () => {
    run(CHAT, ["post", "first user msg", "--thread", "t-r"]);
    run(LEDGER, [
      "create", "--kind", "chat_out", "--type", "interactive",
      "--title", "prior reply", "--body", "prior reply body", "--thread", "t-r",
    ]);
    const r2 = run(CHAT, ["post", "second user msg", "--thread", "t-r"]);
    const newId = JSON.parse(r2.out.trim()).id;

    const rp = run(LEDGER, ["render-prompt", newId, "--worker", "test"]);
    expect(rp.code).toBe(0);
    expect(rp.out).toContain("Prior turns in this thread");
    expect(rp.out).toContain("[user] first user msg");
    expect(rp.out).toContain("[you] prior reply body");
    expect(rp.out).not.toContain("second user msg"); // current turn excluded
    expect(rp.out).toContain("thread=t-r");
  });
});

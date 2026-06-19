// Tests for chat.ts — JSONL chat utilities.
// All I/O uses a temp directory — never touches ~/vault/arc-ux/.

import { test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const ROOT = join("/tmp", `arc-chat-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

beforeEach(() => {
  try { rmSync(ROOT, { recursive: true }); } catch { /* noop */ }
  mkdirSync(ROOT, { recursive: true });
});

function root() { return ROOT; }

// ─── chatPath ────────────────────────────────────────────────────────────────

test("chatPath resolves slug to .jsonl", async () => {
  const { chatPath } = await import("./chat");
  expect(chatPath("my-post", ROOT)).toBe(join(ROOT, "my-post.jsonl"));
  expect(chatPath("abc-123", ROOT)).toBe(join(ROOT, "abc-123.jsonl"));
});

// ─── appendChatLine ──────────────────────────────────────────────────────────

test("appendChatLine creates dir and file on first call", async () => {
  const { appendChatLine, chatPath } = await import("./chat");
  const line = appendChatLine({ role: "user", body: "Hello", blog_id: "test-post" }, ROOT);
  expect(existsSync(chatPath("test-post", ROOT))).toBe(true);
  expect(line.ts).toBeGreaterThan(0);
  expect(line.task_id.length).toBeGreaterThan(0);
  expect(line.spawned).toEqual([]);
});

test("appendChatLine appends, not overwrites", async () => {
  const { appendChatLine } = await import("./chat");
  appendChatLine({ role: "user", body: "First", blog_id: "x" }, ROOT);
  appendChatLine({ role: "user", body: "Second", blog_id: "x" }, ROOT);
  const raw = readFileSync(join(ROOT, "x.jsonl"), "utf8");
  const lines = raw.split("\n").filter(Boolean);
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0]!).body).toBe("First");
  expect(JSON.parse(lines[1]!).body).toBe("Second");
});

test("appendChatLine uses provided task_id and spawned", async () => {
  const { appendChatLine } = await import("./chat");
  const line = appendChatLine({
    role: "assistant",
    body: "Got it",
    blog_id: "b1",
    task_id: "task-abc",
    spawned: ["issue-1"],
  }, ROOT);
  expect(line.task_id).toBe("task-abc");
  expect(line.spawned).toEqual(["issue-1"]);
});

// ─── readChat ────────────────────────────────────────────────────────────────

test("readChat returns [] for absent file", async () => {
  const { readChat } = await import("./chat");
  expect(readChat("does-not-exist", ROOT)).toEqual([]);
});

test("readChat parses all lines", async () => {
  const { appendChatLine, readChat } = await import("./chat");
  appendChatLine({ role: "user", body: "A", blog_id: "r" }, ROOT);
  appendChatLine({ role: "assistant", body: "B", blog_id: "r" }, ROOT);
  appendChatLine({ role: "user", body: "C", blog_id: "r" }, ROOT);
  const lines = readChat("r", ROOT);
  expect(lines.length).toBe(3);
  expect(lines[0]!.role).toBe("user");
  expect(lines[1]!.role).toBe("assistant");
  expect(lines[2]!.role).toBe("user");
});

// ─── lastChatLine ────────────────────────────────────────────────────────────

test("lastChatLine returns last line", async () => {
  const { appendChatLine, lastChatLine } = await import("./chat");
  appendChatLine({ role: "user", body: "First", blog_id: "ll" }, ROOT);
  appendChatLine({ role: "user", body: "Last", blog_id: "ll" }, ROOT);
  const last = lastChatLine("ll", ROOT);
  expect(last?.body).toBe("Last");
});

test("lastChatLine returns null for empty file", async () => {
  const { lastChatLine } = await import("./chat");
  expect(lastChatLine("empty-slog", ROOT)).toBeNull();
});

// ─── updateSpawned ───────────────────────────────────────────────────────────

test("updateSpawned patches matching task_id", async () => {
  const { appendChatLine, updateSpawned } = await import("./chat");
  const line1 = appendChatLine({ role: "user", body: "A", blog_id: "up", task_id: "t1" }, ROOT);
  appendChatLine({ role: "user", body: "B", blog_id: "up", task_id: "t2" }, ROOT);
  appendChatLine({ role: "user", body: "C", blog_id: "up", task_id: "t1" }, ROOT);

  const updated = updateSpawned("up", "t1", ["spawned-1", "spawned-2"], ROOT);
  expect(updated).not.toBeNull();
  expect(updated!.spawned).toEqual(["spawned-1", "spawned-2"]);
  // The LAST matching line (t1 appears at lines 0 and 2; last is line 2)
  // Verify all lines reflect the update
  const { readChat } = await import("./chat");
  const all = readChat("up", ROOT);
  expect(all[2]!.spawned).toEqual(["spawned-1", "spawned-2"]);
  expect(all[0]!.spawned).toEqual([]); // first t1 not updated (not last)
});

test("updateSpawned returns null for missing task_id", async () => {
  const { appendChatLine, updateSpawned } = await import("./chat");
  appendChatLine({ role: "user", body: "A", blog_id: "nx", task_id: "t1" }, ROOT);
  expect(updateSpawned("nx", "nonexistent", ["x"], ROOT)).toBeNull();
});

test("updateSpawned returns null for absent slug", async () => {
  const { updateSpawned } = await import("./chat");
  expect(updateSpawned("absent-slug", "any-task", ["x"], ROOT)).toBeNull();
});

// ─── pendingTriageLines ─────────────────────────────────────────────────────

test("pendingTriageLines filters correctly", async () => {
  const { appendChatLine, pendingTriageLines } = await import("./chat");
  // Line with spawned = [] (pending)
  const l1 = appendChatLine({ role: "user", body: "Help me", blog_id: "pt", task_id: "t1" }, ROOT);
  // Line with spawned populated (already triaged)
  appendChatLine({ role: "user", body: "Also this", blog_id: "pt", task_id: "t2", spawned: ["issue-x"] }, ROOT);
  // Empty body
  appendChatLine({ role: "user", body: "  ", blog_id: "pt", task_id: "t3" }, ROOT);
  // Assistant line
  appendChatLine({ role: "assistant", body: "How can I help?", blog_id: "pt", task_id: "t4" }, ROOT);

  const pending = pendingTriageLines("pt", ROOT);
  expect(pending.length).toBe(1);
  expect(pending[0]!.task_id).toBe(l1.task_id);
});

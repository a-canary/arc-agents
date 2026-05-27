// Tests for src/replay/transcript.ts

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "path";
import {
  parseSessionJsonl,
  stripSignatures,
  stripMetadata,
  extractText,
  extractToolCalls,
  extractSubagents,
  extractMessages,
  stats,
} from "./transcript";

function makeEntry(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

function parseEntries(...lines: string[]) {
  return lines
    .map((l) => {
      if (!l.trim()) return null;
      try { return { type: JSON.parse(l).type, raw: JSON.parse(l) }; }
      catch { return null; }
    })
    .filter(Boolean) as { type: string; raw: unknown }[];
}

describe("stripSignatures", () => {
  const noise = ["last-prompt", "permission-mode", "system-prompt", "file-history-snapshot", "attachment", "deferred_tools_delta", "auto_mode", "hook_success", "hook_failure", "skill_listing", "ai-title", "task_reminder"];
  const content = ["user", "assistant", "result", "error", "tool_use", "tool_result"];

  test("removes all noise types", () => {
    const lines = [
      ...noise.map((t) => makeEntry(t, { foo: "bar" })),
      ...content.map((t) => makeEntry(t, { baz: "qux" })),
    ];
    const entries = parseEntries(...lines);
    const stripped = stripSignatures(entries);
    expect(stripped.map((e) => e.type)).toEqual(content);
  });

  test("passes through content types unchanged", () => {
    const lines = content.map((t) => makeEntry(t, { data: "test" }));
    const entries = parseEntries(...lines);
    const stripped = stripSignatures(entries);
    expect(stripped).toHaveLength(content.length);
    stripped.forEach((e, i) => expect(e.type).toBe(content[i]));
  });

  test("empty input returns empty array", () => {
    expect(stripSignatures([])).toEqual([]);
  });
});

describe("stripMetadata = stripSignatures", () => {
  test("aliases produce identical output", () => {
    const lines = [makeEntry("last-prompt"), makeEntry("user", { message: { content: "hello" } })];
    const entries = parseEntries(...lines);
    expect(stripMetadata(entries)).toEqual(stripSignatures(entries));
  });
});

describe("extractText", () => {
  test("user message text extracted", () => {
    const lines = [
      makeEntry("last-prompt"),
      makeEntry("user", { message: { content: [{ type: "text", text: "hello world" }] } }),
    ];
    const entries = parseEntries(...lines);
    const stripped = stripSignatures(entries);
    expect(extractText(stripped)).toBe("hello world");
  });

  test("assistant message text extracted", () => {
    const lines = [
      makeEntry("assistant", { message: { role: "assistant", content: [{ type: "text", text: "I will help" }] } }),
    ];
    const entries = parseEntries(...lines);
    expect(extractText(entries)).toBe("I will help");
  });

  test("plain string content handled", () => {
    const lines = [
      makeEntry("user", { message: { content: "plain string content" } }),
    ];
    const entries = parseEntries(...lines);
    expect(extractText(entries)).toBe("plain string content");
  });

  test("result type extracted", () => {
    const lines = [
      makeEntry("result", { content: "command output here" }),
    ];
    const entries = parseEntries(...lines);
    expect(extractText(entries)).toBe("command output here");
  });

  test("error type extracted", () => {
    const lines = [
      makeEntry("error", { content: "something went wrong" }),
    ];
    const entries = parseEntries(...lines);
    expect(extractText(entries)).toBe("something went wrong");
  });

  test("noise types skipped", () => {
    const lines = [
      makeEntry("last-prompt"),
      makeEntry("user", { message: { content: [{ type: "text", text: "real" }] } }),
    ];
    const entries = parseEntries(...lines);
    expect(extractText(entries)).toBe("real");
  });
});

describe("extractToolCalls", () => {
  test("tool_use entries parsed", () => {
    const lines = [
      makeEntry("tool_use", {
        id: "tool-001",
        name: "Bash",
        message: { content: "Running test suite" },
        input: { command: "bun test" },
      }),
    ];
    const entries = parseEntries(...lines);
    const calls = extractToolCalls(entries);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("Bash");
    expect(calls[0]!.input).toBe(JSON.stringify({ command: "bun test" }));
    expect(calls[0]!.summary).toBe("Running test suite");
    expect(calls[0]!.id).toBe("tool-001");
  });

  test("tool_result matched to call by tool_use_id", () => {
    const lines = [
      makeEntry("tool_use", {
        id: "tool-abc",
        name: "Read",
        message: { content: "Reading file" },
        input: { path: "/tmp/test" },
      }),
      makeEntry("tool_result", {
        tool_use_id: "tool-abc",
        exit_code: 0,
        content: "file content",
      }),
    ];
    const entries = parseEntries(...lines);
    const calls = extractToolCalls(entries);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.exitCode).toBe(0);
  });

  test("subagent tools skipped from main list", () => {
    const lines = [
      makeEntry("tool_use", { id: "agent-1", name: "Agent", message: { content: "spawn" }, input: {} }),
    ];
    const entries = parseEntries(...lines);
    const calls = extractToolCalls(entries);
    expect(calls).toHaveLength(0);
  });

  test("empty input returns empty", () => {
    expect(extractToolCalls([])).toEqual([]);
  });
});

describe("extractSubagents", () => {
  test("Agent and Task tools captured", () => {
    const lines = [
      makeEntry("tool_use", { id: "a1", name: "Agent", message: {}, input: { description: "spawn worker" } }),
      makeEntry("tool_use", { id: "a2", name: "Task", message: {}, input: { description: "run subtask" } }),
      makeEntry("tool_use", { id: "b1", name: "Bash", message: {}, input: {} }),
    ];
    const entries = parseEntries(...lines);
    const subs = extractSubagents(entries);
    expect(subs).toHaveLength(2);
    expect(subs[0]!.name).toBe("Agent");
    expect(subs[1]!.name).toBe("Task");
  });

  test("purpose from description field", () => {
    const lines = [
      makeEntry("tool_use", { id: "s1", name: "Agent", message: {}, input: { description: "review the PR" } }),
    ];
    const entries = parseEntries(...lines);
    const subs = extractSubagents(entries);
    expect(subs[0]!.purpose).toBe("review the PR");
  });

  test("purpose truncated to 120 chars", () => {
    const long = "x".repeat(200);
    const lines = [
      makeEntry("tool_use", { id: "s1", name: "Agent", message: {}, input: { description: long } }),
    ];
    const entries = parseEntries(...lines);
    const subs = extractSubagents(entries);
    expect(subs[0]!.purpose).toHaveLength(120);
  });
});

describe("extractMessages", () => {
  test("user messages extracted", () => {
    const lines = [
      makeEntry("user", { message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
    ];
    const entries = parseEntries(...lines);
    const msgs = extractMessages(entries);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.text).toBe("do the thing");
  });

  test("assistant messages extracted", () => {
    const lines = [
      makeEntry("assistant", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ];
    const entries = parseEntries(...lines);
    const msgs = extractMessages(entries);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.text).toBe("done");
  });

  test("system messages extracted", () => {
    const lines = [
      makeEntry("system", { content: "system prompt" }),
    ];
    const entries = parseEntries(...lines);
    const msgs = extractMessages(entries);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.text).toBe("system prompt");
  });

  test("empty text skipped", () => {
    const lines = [
      makeEntry("user", { message: { role: "user", content: [{ type: "text", text: "" }] } }),
    ];
    const entries = parseEntries(...lines);
    const msgs = extractMessages(entries);
    expect(msgs).toHaveLength(0);
  });
});

describe("stats", () => {
  test("computes compression ratio", () => {
    const lines = [
      makeEntry("last-prompt"),
      makeEntry("permission-mode"),
      makeEntry("file-history-snapshot"),
      makeEntry("attachment"),
      makeEntry("user", { message: { content: [{ type: "text", text: "hello" }] } }),
      makeEntry("assistant", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ];
    const entries = parseEntries(...lines);
    const s = stats(entries);
    expect(s.totalLines).toBe(6);
    expect(s.strippedLines).toBe(2);
    expect(s.compressionRatio).toBe(3);
    expect(s.userTurns).toBe(1);
    expect(s.assistantTurns).toBe(1);
  });

  test("zero division safe when empty", () => {
    const s = stats([]);
    expect(s.totalLines).toBe(0);
    expect(s.strippedLines).toBe(0);
    expect(s.compressionRatio).toBe(1);
  });
});

describe("parseSessionJsonl", () => {
  test("parses a real session file from the corpus", () => {
    const fixtureDir = join(import.meta.dir, "..", "..", "tests", "replay-corpus", "fix-typecheck-bin-arc-tui-test-ts-missin");
    const path = join(fixtureDir, "session.jsonl");
    try {
      const entries = parseSessionJsonl(path);
      expect(entries.length).toBeGreaterThan(0);
      const stripped = stripSignatures(entries);
      expect(stripped.length).toBeLessThan(entries.length);
      // Should have real content after stripping
      const s = stats(entries);
      expect(s.compressionRatio).toBeGreaterThan(1);
    } catch (e: unknown) {
      // Fixture may not exist in all environments.
      if (e instanceof Error && e.message.includes("ENOENT")) return;
      throw e;
    }
  });
});
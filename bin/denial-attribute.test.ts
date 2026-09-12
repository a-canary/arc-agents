import { describe, expect, test } from "bun:test";
import { attributeDenials, shapeOf, tally } from "./denial-attribute";

const DENIAL_TEXT =
  "Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.";

function use(id: string, name: string, input: Record<string, unknown>) {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
}

function result(id: string, text: string) {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  });
}

describe("attributeDenials", () => {
  test("resolves a denial to the tool name and command", () => {
    const jsonl = [
      use("toolu_1", "Bash", { command: "git worktree remove --force /p/x" }),
      result("toolu_1", DENIAL_TEXT),
    ].join("\n");
    const d = attributeDenials(jsonl);
    expect(d).toHaveLength(1);
    expect(d[0]!.tool).toBe("Bash");
    expect(d[0]!.args).toBe("git worktree remove --force /p/x");
    expect(d[0]!.reason).toBe("Blocked by classifier");
  });

  test("ignores tool calls that succeeded", () => {
    const jsonl = [
      use("toolu_ok", "Bash", { command: "ls" }),
      result("toolu_ok", "file-a\nfile-b"),
      use("toolu_no", "Bash", { command: "rm -rf /p" }),
      result("toolu_no", DENIAL_TEXT),
    ].join("\n");
    const d = attributeDenials(jsonl);
    expect(d).toHaveLength(1);
    expect(d[0]!.args).toBe("rm -rf /p");
  });

  test("counts a replayed denial once", () => {
    // Transcripts repeat earlier turns; the same tool_use_id recurs.
    const jsonl = [
      use("toolu_1", "Bash", { command: "git worktree remove /p" }),
      result("toolu_1", DENIAL_TEXT),
      result("toolu_1", DENIAL_TEXT),
    ].join("\n");
    expect(attributeDenials(jsonl)).toHaveLength(1);
  });

  test("handles result content given as text blocks", () => {
    const jsonl = [
      use("toolu_1", "Write", { file_path: "/etc/x", content: "y" }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: DENIAL_TEXT }] }],
        },
      }),
    ].join("\n");
    const d = attributeDenials(jsonl);
    expect(d).toHaveLength(1);
    expect(d[0]!.tool).toBe("Write");
    expect(d[0]!.args).toContain("/etc/x"); // non-Bash falls back to JSON of input
  });

  test("reports a denial whose tool_use block is missing rather than dropping it", () => {
    const d = attributeDenials(result("toolu_gone", DENIAL_TEXT));
    expect(d).toHaveLength(1);
    expect(d[0]!.tool).toBe("<unresolved>");
  });

  test("survives a truncated trailing line", () => {
    const jsonl = [use("toolu_1", "Bash", { command: "ls" }), result("toolu_1", DENIAL_TEXT), '{"type":"assis'].join(
      "\n",
    );
    expect(attributeDenials(jsonl)).toHaveLength(1);
  });

  test("no denials yields an empty list", () => {
    const jsonl = [use("toolu_1", "Bash", { command: "ls" }), result("toolu_1", "ok")].join("\n");
    expect(attributeDenials(jsonl)).toEqual([]);
  });
});

describe("shapeOf", () => {
  test("strips a cd prefix, flags, and paths", () => {
    expect(shapeOf("cd /home/aaron/repos/x && git worktree remove --force /p/y 2>&1")).toBe("git worktree remove");
  });

  test("clusters the same verb regardless of target path", () => {
    expect(shapeOf("git worktree remove /a")).toBe(shapeOf("git worktree remove --force /b"));
  });

  test("keeps a bare command", () => {
    expect(shapeOf("ls")).toBe("ls");
  });
});

describe("tally", () => {
  test("groups a repeated cause into one row", () => {
    const jsonl = [
      use("t1", "Bash", { command: "cd /r && git worktree remove --force /a" }),
      result("t1", DENIAL_TEXT),
      use("t2", "Bash", { command: "git worktree remove /b" }),
      result("t2", DENIAL_TEXT),
      use("t3", "Bash", { command: "echo hi" }),
      result("t3", DENIAL_TEXT),
    ].join("\n");
    const t = tally(attributeDenials(jsonl));
    expect(t[0]!.count).toBe(2);
    expect(t[0]!.key).toBe("Bash\tgit worktree remove");
    expect(t[1]!.count).toBe(1);
  });
});

describe("shapeOf multi-line cd", () => {
  test("strips a cd prefix with no && separator", () => {
    // A multi-line `cd p\n git ...` flattens to a bare space.
    expect(shapeOf("cd /home/aaron/repos/x git worktree remove --force /p 2>&1")).toBe("git worktree remove");
  });
});

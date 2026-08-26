import { describe, expect, test } from "bun:test";
import { upsertBlock, removeBlock, blockName, upsertStatus, MARKER_OPEN, MARKER_CLOSE } from "./cron-install";

const A = "# >>> a >>>";
const A_END = "# <<< a <<<";

describe("upsertBlock", () => {
  test("appends a new block to empty crontab", () => {
    const out = upsertBlock("", "a", "0 * * * * /bin/true");
    expect(out.split("\n")).toContain(A);
    expect(out.split("\n")).toContain("0 * * * * /bin/true");
    expect(out.split("\n")).toContain(A_END);
  });

  test("appends after existing content with blank separator", () => {
    const out = upsertBlock("# foreign\n*/5 * * * * /x/y.sh", "a", "0 * * * * /bin/true");
    const lines = out.split("\n");
    expect(lines[0]).toBe("# foreign");
    expect(lines[1]).toBe("*/5 * * * * /x/y.sh");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe(A);
  });

  test("replaces existing block in place, preserving position and foreign lines", () => {
    const cur = [
      "# foreign top",
      A,
      "old entry",
      A_END,
      "# foreign bottom",
    ].join("\n");
    const out = upsertBlock(cur, "a", "new entry 1\nnew entry 2");
    const lines = out.split("\n");
    expect(lines[0]).toBe("# foreign top");
    expect(lines[1]).toBe(A);
    expect(lines[2]).toBe("new entry 1");
    expect(lines[3]).toBe("new entry 2");
    expect(lines[4]).toBe(A_END);
    expect(lines[5]).toBe("# foreign bottom");
    expect(out).not.toContain("old entry");
  });

  test("idempotent: double upsert yields identical output", () => {
    const once = upsertBlock("", "a", "0 * * * * /bin/true");
    const twice = upsertBlock(once, "a", "0 * * * * /bin/true");
    expect(twice).toBe(once);
  });

  test("does not touch other marker blocks", () => {
    const cur = `# >>> b >>>\nkeep me\n# <<< b <<<`;
    const out = upsertBlock(cur, "a", "0 * * * * /bin/true");
    expect(out).toContain("keep me");
  });

  test("throws on malformed block (missing close marker)", () => {
    expect(() => upsertBlock(`${A}\nold entry`, "a", "new")).toThrow(/close marker/);
  });
});

describe("removeBlock", () => {
  test("removes a block and one trailing blank line", () => {
    const cur = ["# top", A, "entry", A_END, "", "# bottom"].join("\n");
    expect(removeBlock(cur, "a")).toBe("# top\n# bottom");
  });

  test("no-op for unknown name", () => {
    const cur = "# top\n0 * * * * /bin/true";
    expect(removeBlock(cur, "zzz")).toBe(cur);
  });

  test("throws on malformed block", () => {
    expect(() => removeBlock(`${A}\nentry`, "a")).toThrow(/close marker/);
  });
});

describe("upsertStatus", () => {
  test("appended for new name, replaced for existing block", () => {
    const cur = `${A}\nentry\n${A_END}`;
    expect(upsertStatus(cur, "a")).toBe("replaced");
    expect(upsertStatus(cur, "b")).toBe("appended");
  });
});

describe("blockName", () => {
  test("basename without extension", () => {
    expect(blockName("/home/aaron/repos/arc-agents/bin/cron/recovery-sweep.cron")).toBe(
      "recovery-sweep",
    );
  });
});

describe("markers", () => {
  test("marker shape matches existing crontab convention", () => {
    expect(MARKER_OPEN("x")).toBe("# >>> x >>>");
    expect(MARKER_CLOSE("x")).toBe("# <<< x <<<");
  });
});

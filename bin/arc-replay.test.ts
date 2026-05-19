import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(REPO, "bin", "arc-replay.ts");

function run(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [BIN, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("arc-replay dispatch", () => {
  it("prints usage with no args (exit 2)", () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });

  it("rejects unknown verbs", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown verb");
  });
});

describe("arc-replay capture", () => {
  it("requires a turn-id", () => {
    const r = run(["capture"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("capture");
  });

  it("dispatches with a turn-id and emits JSON", () => {
    const r = run(["capture", "turn-xyz"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out.trim());
    expect(j.verb).toBe("capture");
    expect(j.turn_id).toBe("turn-xyz");
  });
});

describe("arc-replay replay", () => {
  it("requires a capture arg", () => {
    const r = run(["replay"]);
    expect(r.code).toBe(2);
  });

  it("requires --config", () => {
    const r = run(["replay", "cap-1"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--config");
  });

  it("dispatches with capture + --config", () => {
    const r = run(["replay", "cap-1", "--config", "/tmp/c.json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out.trim());
    expect(j.verb).toBe("replay");
    expect(j.capture).toBe("cap-1");
    expect(j.config).toBe("/tmp/c.json");
  });

  it("accepts --config=path form", () => {
    const r = run(["replay", "cap-1", "--config=/tmp/c.json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim()).config).toBe("/tmp/c.json");
  });
});

describe("arc-replay diff", () => {
  it("requires two captures", () => {
    const r = run(["diff", "only-one"]);
    expect(r.code).toBe(2);
  });

  it("dispatches with two captures", () => {
    const r = run(["diff", "cap-a", "cap-b"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out.trim());
    expect(j.verb).toBe("diff");
    expect(j.a).toBe("cap-a");
    expect(j.b).toBe("cap-b");
  });
});

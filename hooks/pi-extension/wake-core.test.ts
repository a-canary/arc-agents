import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWakeCore, readProcStartTime, type WakeMessage } from "./wake-core.ts";
import { makeSpawnCmd } from "./ledger-wake.ts";

const SESSION = "sess-test";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "wakeme-"));
  return join(dir, "reqs.jsonl");
}

interface Harness {
  file: string;
  wakes: WakeMessage[];
  tick: () => Promise<void>;
  append: (o: object) => void;
}

function harness(overrides: Partial<Parameters<typeof createWakeCore>[0]> = {}): Harness {
  const file = tmpFile();
  const wakes: WakeMessage[] = [];
  const core = createWakeCore({
    readRequests: () => {
      try {
        return readFileSync(file, "utf-8");
      } catch {
        return "";
      }
    },
    send: (m) => wakes.push(m),
    ...overrides,
  });
  core.setSession(SESSION);
  return {
    file,
    wakes,
    tick: () => core.tick(),
    append: (o) => writeFileSync(file, JSON.stringify(o) + "\n", { flag: "a" }),
  };
}

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(iv);
        reject(new Error("timeout waiting for condition"));
      }
    }, 25);
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wakeme-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("row watches", () => {
  it("fires exactly once when the row enters a watched state", async () => {
    const rows = new Map<string, { id: string; state: string }>([["r1", { id: "r1", state: "wip" }]]);
    const h = harness({ readRow: (id) => rows.get(id) });
    h.append({ session: SESSION, type: "row", id: "r1", states: ["merged"], ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(0); // armed, not yet terminal

    rows.set("r1", { id: "r1", state: "merged" });
    await h.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("✅ r1 → merged");

    await h.tick(); // one-shot: no re-wake
    expect(h.wakes).toHaveLength(1);
  });

  it("fires immediately when the row is already in a watched state at arm time", async () => {
    const h = harness({ readRow: () => ({ id: "r2", state: "failed" }) });
    h.append({ session: SESSION, type: "row", id: "r2", states: ["merged", "failed"], ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("❌ r2 → failed");
  });

  it("includes blocked_by in the wake message when present", async () => {
    const rows = new Map<string, { id: string; state: string; blocked_by?: string }>([
      ["r3", { id: "r3", state: "ready" }],
    ]);
    const h = harness({ readRow: (id) => rows.get(id) });
    h.append({ session: SESSION, type: "row", id: "r3", states: ["blocked"], ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(0);

    rows.set("r3", { id: "r3", state: "blocked", blocked_by: "a,b" });
    await h.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("⚠️ r3 → blocked (blocked by a,b)");
  });

  it("ignores rows that never enter the watched states", async () => {
    const rows = new Map<string, { id: string; state: string }>([["r4", { id: "r4", state: "wip" }]]);
    const h = harness({ readRow: (id) => rows.get(id) });
    h.append({ session: SESSION, type: "row", id: "r4", states: ["merged"], ts: Date.now() });
    await h.tick();
    rows.set("r4", { id: "r4", state: "review" });
    await h.tick();
    expect(h.wakes).toHaveLength(0);
  });

  it("dedupes re-appended identical lines to a single wake and no double-spawn", async () => {
    const rows = new Map<string, { id: string; state: string }>([["r5", { id: "r5", state: "wip" }]]);
    let spawns = 0;
    const h = harness({ readRow: (id) => rows.get(id), spawnCmd: () => { spawns++; return Promise.resolve({ code: 0, output: "" }); } });
    const line = { session: SESSION, type: "row", id: "r5", states: ["merged"], ts: Date.now() };
    h.append(line);
    h.append(line); // re-appended identical line
    await h.tick();
    expect(h.wakes).toHaveLength(0);

    rows.set("r5", { id: "r5", state: "merged" });
    await h.tick();
    await h.tick();
    expect(h.wakes).toHaveLength(1);

    // cmd variant of dedup: re-append must not spawn a second time
    const line2 = { session: SESSION, type: "cmd", cmd: "npm test", label: "unit tests", cwd: "/proj", ts: Date.now() };
    h.append(line2);
    h.append(line2);
    await h.tick();
    expect(spawns).toBe(1);
  });
});

describe("pid watches", () => {
  it("fires exactly once when the process dies", async () => {
    let alive = true;
    const h = harness({ checkPid: () => alive });
    h.append({ session: SESSION, type: "pid", pid: 4242, label: "training run", startTime: 999, ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(0);

    alive = false;
    await h.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("⚠️ pid 4242 stopped (training run)");
    await h.tick();
    expect(h.wakes).toHaveLength(1);
  });

  it("readProcStartTime: live pid > 0, dead pid = 0", () => {
    if (process.platform !== "linux") return; // /proc only
    expect(readProcStartTime(1)).toBeGreaterThan(0);
    let deadPid = 999_999;
    while (readProcStartTime(deadPid) > 0) deadPid++;
    expect(readProcStartTime(deadPid)).toBe(0);
  });
});

describe("cmd watches", () => {
  it("spawns once with cwd, wakes on exit with the label", async () => {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    let release!: (r: { code: number; output: string }) => void;
    const h = harness({
      spawnCmd: (cmd, cwd) => {
        calls.push({ cmd, cwd });
        return new Promise<{ code: number; output: string }>((res) => {
          release = res;
        });
      },
    });
    h.append({ session: SESSION, type: "cmd", cmd: "npm test", label: "unit tests", cwd: "/proj", ts: Date.now() });
    const t = h.tick(); // blocks until the spawn resolves
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([{ cmd: "npm test", cwd: "/proj" }]);
    expect(h.wakes).toHaveLength(0);

    release({ code: 0, output: "/log/path" });
    await t;
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("✅ unit tests exit=0 (/log/path)");
  });

  it("wakes with ❌ on non-zero exit", async () => {
    const h = harness({ spawnCmd: () => Promise.resolve({ code: 3, output: "/log" }) });
    h.append({ session: SESSION, type: "cmd", cmd: "false", label: "smoke", ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("❌ smoke exit=3 (/log)");
  });

  it("treats a spawn failure as an immediate ❌ wake", async () => {
    const h = harness({ spawnCmd: () => Promise.resolve({ code: 1, output: "spawn error" }) });
    h.append({ session: SESSION, type: "cmd", cmd: "/nonexistent-binary", label: "ghost", ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0].content).toBe("❌ ghost exit=1 (spawn error)");
  });

  it("runs a real short-lived command through makeSpawnCmd and logs output", async () => {
    const logDir = join(dir, "logs");
    const h = harness({ spawnCmd: makeSpawnCmd(logDir) });
    h.append({ session: SESSION, type: "cmd", cmd: `echo hello-wakeme; echo err >&2`, label: "real", cwd: dir, ts: Date.now() });
    void h.tick(); // one tick arms and awaits the exit (glue would poll every 15s)
    await waitFor(() => h.wakes.length === 1);
    expect(h.wakes[0].content.startsWith("✅ real exit=0 (")).toBe(true);
    const logFile = h.wakes[0].content.slice("✅ real exit=0 (".length, -1);
    const out = readFileSync(logFile, "utf-8");
    expect(out).toContain("hello-wakeme");
    expect(out).toContain("err");
  });

  it("real failing command wakes with its exit code", async () => {
    const h = harness({ spawnCmd: makeSpawnCmd(join(dir, "logs2")) });
    h.append({ session: SESSION, type: "cmd", cmd: "exit 7", label: "boom", cwd: dir, ts: Date.now() });
    void h.tick();
    await waitFor(() => h.wakes.length === 1);
    expect(h.wakes[0].content.startsWith("❌ boom exit=7")).toBe(true);
  });
});

describe("scoping and priming", () => {
  it("ignores lines from other sessions", async () => {
    const h = harness({ checkPid: () => false }); // would fire if armed
    h.append({ session: "other-session", type: "pid", pid: 7, label: "x", startTime: 1, ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(0);
  });

  it("primes silently: lines predating the session start do not wake", async () => {
    const file = tmpFile();
    const wakes: WakeMessage[] = [];
    const core = createWakeCore({
      readRequests: () => {
        try {
          return readFileSync(file, "utf-8");
        } catch {
          return "";
        }
      },
      readRow: () => ({ id: "r9", state: "merged" }), // already terminal
      send: (m) => wakes.push(m),
    });
    core.setSession(SESSION);
    const start = Date.now();
    writeFileSync(file, JSON.stringify({ session: SESSION, type: "row", id: "r9", states: ["merged"], ts: start - 1000 }) + "\n");
    await core.tick();
    expect(wakes).toHaveLength(0); // consumed silently even though row is terminal
  });

  it("skips corrupt lines and counts them via onCorruptLine", async () => {
    const file = tmpFile();
    writeFileSync(file, "not json\n" + JSON.stringify({ session: SESSION, type: "pid", pid: 5, label: "ok", startTime: 1, ts: Date.now() }) + "\n");
    let corruptCount = 0;
    const core = createWakeCore({
      readRequests: () => readFileSync(file, "utf-8"),
      checkPid: () => false,
      send: () => {},
      onCorruptLine: () => {
        corruptCount++;
      },
    });
    core.setSession(SESSION);
    await core.tick();
    expect(corruptCount).toBe(1);
  });

  it("unknown watch types are skipped (forward-compatible)", async () => {
    const h = harness({});
    h.append({ session: SESSION, type: "webhook", url: "http://x", ts: Date.now() });
    await h.tick();
    expect(h.wakes).toHaveLength(0);
  });
});

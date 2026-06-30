import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governor, resolveState, type GovernorState } from "./director-governor";

function st(over: Partial<GovernorState> = {}): GovernorState {
  return {
    killed: false,
    paused: false,
    tokensThisWeek: 0,
    repoBudget: 1000,
    ...over,
  };
}

// ── Part A: pure precedence golden tests ─────────────────────────────────────

test("governor: ok when nothing tripped", () => {
  const v = governor(st({ tokensThisWeek: 100, repoBudget: 1000 }));
  expect(v).toEqual({ allowCaller: true, allowSpawn: true, restrictTo: null, reason: "ok" });
});

test("governor: killed ⇒ caller must not run at all", () => {
  const v = governor(st({ killed: true }));
  expect(v).toEqual({ allowCaller: false, allowSpawn: false, restrictTo: null, reason: "killed" });
});

test("governor: killed has highest precedence over paused + over-budget", () => {
  const v = governor(
    st({ killed: true, paused: true, tokensThisWeek: 9999, repoBudget: 1000 }),
  );
  expect(v.reason).toBe("killed");
  expect(v.allowCaller).toBe(false);
  expect(v.allowSpawn).toBe(false);
});

test("governor: paused ⇒ alive but no new work", () => {
  const v = governor(st({ paused: true }));
  expect(v).toEqual({ allowCaller: true, allowSpawn: false, restrictTo: null, reason: "paused" });
});

test("governor: paused takes precedence over over-budget", () => {
  const v = governor(st({ paused: true, tokensThisWeek: 9999, repoBudget: 1000 }));
  expect(v.reason).toBe("paused");
  expect(v.allowCaller).toBe(true);
  expect(v.allowSpawn).toBe(false);
  expect(v.restrictTo).toBe(null);
});

test("governor: over budget ⇒ alive, ordinary spawn blocked, critical-only restriction", () => {
  const v = governor(st({ tokensThisWeek: 1500, repoBudget: 1000 }));
  expect(v.allowCaller).toBe(true);
  expect(v.allowSpawn).toBe(false);
  expect(v.restrictTo).toBe("critical-only");
  expect(v.reason).toBe(
    "weekly token budget exhausted (1500/1000) — critical-failure/security work only",
  );
});

test("governor: exactly at budget ⇒ over budget (>= gate)", () => {
  const v = governor(st({ tokensThisWeek: 1000, repoBudget: 1000 }));
  expect(v.allowSpawn).toBe(false);
  expect(v.restrictTo).toBe("critical-only");
});

test("governor: just under budget ⇒ ok", () => {
  const v = governor(st({ tokensThisWeek: 999, repoBudget: 1000 }));
  expect(v).toEqual({ allowCaller: true, allowSpawn: true, restrictTo: null, reason: "ok" });
});

test("governor: repoBudget=0 ⇒ no budget limit (never instantly-exhausted)", () => {
  const v = governor(st({ tokensThisWeek: 5000, repoBudget: 0 }));
  expect(v).toEqual({ allowCaller: true, allowSpawn: true, restrictTo: null, reason: "ok" });
});

test("governor: negative repoBudget ⇒ no budget limit", () => {
  const v = governor(st({ tokensThisWeek: 5000, repoBudget: -1 }));
  expect(v).toEqual({ allowCaller: true, allowSpawn: true, restrictTo: null, reason: "ok" });
});

test("governor: repoBudget<=0 but paused ⇒ paused still wins", () => {
  const v = governor(st({ paused: true, tokensThisWeek: 5000, repoBudget: 0 }));
  expect(v.reason).toBe("paused");
  expect(v.allowSpawn).toBe(false);
});

// ── Part B: thin CLI shell smoke test ────────────────────────────────────────

test("resolveState: present KILL sentinel ⇒ killed=true", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "alpha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "KILL"), "");
    const state = resolveState({
      sentinelDir: dir,
      repoBudget: 1000,
      tokensThisWeek: 0,
    });
    expect(state.killed).toBe(true);
    expect(governor(state).allowCaller).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveState: present PAUSE sentinel ⇒ paused=true, killed=false", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "beta");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PAUSE"), "");
    const state = resolveState({
      sentinelDir: dir,
      repoBudget: 1000,
      tokensThisWeek: 0,
    });
    expect(state.paused).toBe(true);
    expect(state.killed).toBe(false);
    expect(governor(state).allowSpawn).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveState: no sentinels ⇒ neither flag set", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const state = resolveState({
      sentinelDir: join(home, "gamma"),
      repoBudget: 1000,
      tokensThisWeek: 50,
    });
    expect(state.killed).toBe(false);
    expect(state.paused).toBe(false);
    expect(governor(state).reason).toBe("ok");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

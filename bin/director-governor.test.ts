import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governor, resolveState, readWeeklyTokens, writeWeeklyTokens, readWeeklyTokensForDirector, writeWeeklyTokensForDirector, weeklyTokensFileName, type GovernorState } from "./director-governor";

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

// ── Part C: per-repo weekly token file tests ─────────────────────────────────

test("readWeeklyTokens: absent file ⇒ 0", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const n = readWeeklyTokens(join(home, "no-such-dir"));
    expect(n).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: empty file ⇒ 0", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    mkdirSync(join(home, "repo"), { recursive: true });
    writeFileSync(join(home, "repo", "WEEKLY_TOKENS"), "");
    expect(readWeeklyTokens(join(home, "repo"))).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: reads integer value", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    mkdirSync(join(home, "repo"), { recursive: true });
    writeFileSync(join(home, "repo", "WEEKLY_TOKENS"), "123456");
    expect(readWeeklyTokens(join(home, "repo"))).toBe(123456);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: negative value clamped to 0", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    mkdirSync(join(home, "repo"), { recursive: true });
    writeFileSync(join(home, "repo", "WEEKLY_TOKENS"), "-500");
    expect(readWeeklyTokens(join(home, "repo"))).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: non-numeric content ⇒ 0", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    mkdirSync(join(home, "repo"), { recursive: true });
    writeFileSync(join(home, "repo", "WEEKLY_TOKENS"), "not-a-number");
    expect(readWeeklyTokens(join(home, "repo"))).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: float truncated to integer", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    mkdirSync(join(home, "repo"), { recursive: true });
    writeFileSync(join(home, "repo", "WEEKLY_TOKENS"), "123.9");
    expect(readWeeklyTokens(join(home, "repo"))).toBe(123);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: full integration — file drives governor verdict", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    // Write a WEEKLY_TOKENS file with high spend
    writeFileSync(join(dir, "WEEKLY_TOKENS"), "9000");
    const state = resolveState({
      sentinelDir: dir,
      repoBudget: 5000,
      tokensThisWeek: readWeeklyTokens(dir),
    });
    expect(state.tokensThisWeek).toBe(9000);
    expect(governor(state).allowSpawn).toBe(false);
    expect(governor(state).restrictTo).toBe("critical-only");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokens: independent per-repo tracking — two repos with different spend", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const repoA = join(home, "repo-a");
    const repoB = join(home, "repo-b");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    writeFileSync(join(repoA, "WEEKLY_TOKENS"), "2000");
    writeFileSync(join(repoB, "WEEKLY_TOKENS"), "15000");

    const budget = 10000;
    const stateA = resolveState({
      sentinelDir: repoA,
      repoBudget: budget,
      tokensThisWeek: readWeeklyTokens(repoA),
    });
    const stateB = resolveState({
      sentinelDir: repoB,
      repoBudget: budget,
      tokensThisWeek: readWeeklyTokens(repoB),
    });

    // repo-a: 2000 < 10000 ⇒ ok
    expect(governor(stateA).allowSpawn).toBe(true);
    expect(governor(stateA).reason).toBe("ok");
    // repo-b: 15000 >= 10000 ⇒ over budget
    expect(governor(stateB).allowSpawn).toBe(false);
    expect(governor(stateB).restrictTo).toBe("critical-only");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Part D: writeWeeklyTokens tests ───────────────────────────────────────────

test("writeWeeklyTokens: creates file with correct value when absent", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    const result = writeWeeklyTokens(dir, 5000);
    expect(result).toBe(5000);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS"), "utf8").trim()).toBe("5000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokens: accumulates with existing value", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS"), "3000");
    const result = writeWeeklyTokens(dir, 7000);
    expect(result).toBe(10000);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS"), "utf8").trim()).toBe("10000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokens: negative tokens returns NaN, does not modify file", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS"), "1000");
    const result = writeWeeklyTokens(dir, -500);
    expect(Number.isNaN(result)).toBe(true);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS"), "utf8").trim()).toBe("1000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokens: NaN tokens returns NaN", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    const result = writeWeeklyTokens(dir, NaN);
    expect(Number.isNaN(result)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokens: non-existent sentinel dir returns NaN", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const result = writeWeeklyTokens(join(home, "no-such-dir"), 1000);
    expect(Number.isNaN(result)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── Part E: weeklyTokensFileName tests ────────────────────────────────────────

test("weeklyTokensFileName: no director name returns WEEKLY_TOKENS", () => {
  expect(weeklyTokensFileName()).toBe("WEEKLY_TOKENS");
  expect(weeklyTokensFileName("")).toBe("WEEKLY_TOKENS");
});

test("weeklyTokensFileName: with director name returns WEEKLY_TOKENS_<name>", () => {
  expect(weeklyTokensFileName("alpha")).toBe("WEEKLY_TOKENS_alpha");
  expect(weeklyTokensFileName("repo-a-director")).toBe("WEEKLY_TOKENS_repo-a-director");
});

// ── Part F: per-Director token tracking tests ─────────────────────────────────

test("readWeeklyTokensForDirector: absent file ⇒ 0", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const n = readWeeklyTokensForDirector(join(home, "no-such-dir"), "alpha");
    expect(n).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokensForDirector: empty director name falls back to readWeeklyTokens", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS"), "500");
    expect(readWeeklyTokensForDirector(dir, "")).toBe(500);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokensForDirector: reads per-director value", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS_alpha"), "3000");
    expect(readWeeklyTokensForDirector(dir, "alpha")).toBe(3000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokensForDirector: independent from base WEEKLY_TOKENS", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS"), "999");
    writeFileSync(join(dir, "WEEKLY_TOKENS_beta"), "777");
    expect(readWeeklyTokensForDirector(dir, "beta")).toBe(777);
    expect(readWeeklyTokens(dir)).toBe(999);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readWeeklyTokensForDirector: non-numeric content ⇒ 0", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS_gamma"), "not-a-number");
    expect(readWeeklyTokensForDirector(dir, "gamma")).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokensForDirector: creates per-director file when absent", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    const result = writeWeeklyTokensForDirector(dir, "delta", 4000);
    expect(result).toBe(4000);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS_delta"), "utf8").trim()).toBe("4000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokensForDirector: accumulates per-director value", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS_epsilon"), "2000");
    const result = writeWeeklyTokensForDirector(dir, "epsilon", 3000);
    expect(result).toBe(5000);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS_epsilon"), "utf8").trim()).toBe("5000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokensForDirector: does not affect base WEEKLY_TOKENS", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS"), "100");
    writeWeeklyTokensForDirector(dir, "zeta", 500);
    // base WEEKLY_TOKENS should be unchanged
    expect(readFileSync(join(dir, "WEEKLY_TOKENS"), "utf8").trim()).toBe("100");
    expect(readWeeklyTokensForDirector(dir, "zeta")).toBe(500);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokensForDirector: negative tokens returns NaN, does not modify file", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS_eta"), "1000");
    const result = writeWeeklyTokensForDirector(dir, "eta", -100);
    expect(Number.isNaN(result)).toBe(true);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS_eta"), "utf8").trim()).toBe("1000");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokensForDirector: empty director name delegates to writeWeeklyTokens", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    const result = writeWeeklyTokensForDirector(dir, "", 500);
    expect(result).toBe(500);
    expect(readFileSync(join(dir, "WEEKLY_TOKENS"), "utf8").trim()).toBe("500");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeWeeklyTokensForDirector: non-existent dir returns NaN", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const result = writeWeeklyTokensForDirector(join(home, "no-such"), "theta", 100);
    expect(Number.isNaN(result)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveState: directorName is surfaced when provided", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "WEEKLY_TOKENS_iota"), "7500");
    const state = resolveState({
      sentinelDir: dir,
      repoBudget: 10000,
      tokensThisWeek: readWeeklyTokensForDirector(dir, "iota"),
    });
    expect(state.tokensThisWeek).toBe(7500);
    expect(governor(state).allowSpawn).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveState: two directors in same sentinel dir have independent budgets", () => {
  const home = mkdtempSync(join(tmpdir(), "dir-gov-"));
  try {
    const dir = join(home, "shared-repo");
    mkdirSync(dir, { recursive: true });
    // Director A: within budget
    writeFileSync(join(dir, "WEEKLY_TOKENS_director-a"), "2000");
    // Director B: over budget
    writeFileSync(join(dir, "WEEKLY_TOKENS_director-b"), "12000");
    const budget = 10000;

    const stateA = resolveState({
      sentinelDir: dir,
      repoBudget: budget,
      tokensThisWeek: readWeeklyTokensForDirector(dir, "director-a"),
    });
    const stateB = resolveState({
      sentinelDir: dir,
      repoBudget: budget,
      tokensThisWeek: readWeeklyTokensForDirector(dir, "director-b"),
    });

    expect(governor(stateA).allowSpawn).toBe(true);
    expect(governor(stateA).reason).toBe("ok");
    expect(governor(stateB).allowSpawn).toBe(false);
    expect(governor(stateB).restrictTo).toBe("critical-only");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

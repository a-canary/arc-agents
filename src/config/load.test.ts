import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveAlias } from "./load";

const repoRoot = join(import.meta.dir, "..", "..");

test("loadConfig parses the real repo config.json", () => {
  const cfg = loadConfig(repoRoot);
  expect(typeof cfg.default_alias).toBe("string");
  expect(Object.keys(cfg.exec_cli_alias).length).toBeGreaterThan(0);
  expect(typeof cfg.pool_caps).toBe("object");
});

test("resolveAlias returns the right command for a known alias", () => {
  const cfg = loadConfig(repoRoot);
  const cmd = resolveAlias("opus-max", cfg);
  expect(cmd).toContain("--model opus");
  expect(cmd).toContain("{prompt}");
});

test("resolveAlias falls back to default_alias command for unknown alias", () => {
  const cfg = loadConfig(repoRoot);
  const fallback = cfg.exec_cli_alias[cfg.default_alias]!;
  const cmd = resolveAlias("nonexistent-alias-xyz", cfg);
  expect(cmd).toBe(fallback);
});

test("loadConfig throws when an alias command is missing {prompt}", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: {
        "good-alias": "claude --model opus {prompt}",
        "bad-alias": "claude --model opus --effort max",
      },
      pool_caps: { default: 4 },
      default_alias: "good-alias",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow("bad-alias");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a `claude --model` alias naming a non-Claude (provider) model", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: {
        // The exact pre-b66589e regression: a provider model routed through
        // interactive `claude`, which dies on spawn ("model may not exist").
        "minimax-build": "claude --model minimax-m2.7 --effort high {prompt}",
      },
      pool_caps: { default: 4 },
      default_alias: "minimax-build",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow("not a known Claude model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig allows provider models via `pi -p --provider` and real claude models", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const ok = {
      exec_cli_alias: {
        "opus-max": "claude --model opus --effort max {prompt}",
        "minimax-build": "pi -p --provider minimax --model MiniMax-M2.7 {prompt}",
      },
      pool_caps: { default: 4 },
      default_alias: "opus-max",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(ok));
    expect(() => loadConfig(dir)).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAlias throws when default_alias is missing from map", () => {
  const cfg = {
    exec_cli_alias: { "opus-max": "claude --model opus {prompt}" },
    pool_caps: { default: 4 },
    default_alias: "missing-default",
  };
  expect(() => resolveAlias("no-such-alias", cfg)).toThrow("missing-default");
});

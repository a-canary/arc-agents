// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  resolveAlias,
  resolveFast,
  resolveSmart,
  type Config,
} from "./load";

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

test("loadConfig rejects fast_alias that does not name an exec_cli_alias key", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: { "opus-max": "claude --model opus {prompt}" },
      pool_caps: { default: 4 },
      default_alias: "opus-max",
      fast_alias: "ghost-alias",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow(/fast_alias.*ghost-alias.*not a key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects smart_alias that does not name an exec_cli_alias key", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: { "opus-max": "claude --model opus {prompt}" },
      pool_caps: { default: 4 },
      default_alias: "opus-max",
      smart_alias: "ghost-alias",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow(/smart_alias.*ghost-alias.*not a key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig accepts fast_alias and smart_alias that resolve in exec_cli_alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const ok = {
      exec_cli_alias: {
        "opus-max": "claude --model opus --effort max {prompt}",
        "minimax-fast":
          "pi -p --provider minimax --model MiniMax-M2.7 --thinking low {prompt}",
      },
      pool_caps: { default: 4 },
      default_alias: "minimax-fast",
      fast_alias: "minimax-fast",
      smart_alias: "opus-max",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(ok));
    const cfg = loadConfig(dir);
    expect(cfg.fast_alias).toBe("minimax-fast");
    expect(cfg.smart_alias).toBe("opus-max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig accepts a config with neither fast_alias nor smart_alias set", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const ok = {
      exec_cli_alias: { "opus-max": "claude --model opus {prompt}" },
      pool_caps: { default: 4 },
      default_alias: "opus-max",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(ok));
    const cfg = loadConfig(dir);
    expect(cfg.fast_alias).toBeUndefined();
    expect(cfg.smart_alias).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFast / resolveSmart return the resolved alias and command", () => {
  const cfg: Config = {
    exec_cli_alias: {
      "opus-max": "claude --model opus --effort max {prompt}",
      "minimax-fast":
        "pi -p --provider minimax --model MiniMax-M2.7 --thinking low {prompt}",
    },
    pool_caps: { default: 4 },
    default_alias: "minimax-fast",
    fast_alias: "minimax-fast",
    smart_alias: "opus-max",
  };
  expect(resolveFast(cfg)).toEqual({
    alias: "minimax-fast",
    command:
      "pi -p --provider minimax --model MiniMax-M2.7 --thinking low {prompt}",
  });
  expect(resolveSmart(cfg)).toEqual({
    alias: "opus-max",
    command: "claude --model opus --effort max {prompt}",
  });
});

test("resolveFast / resolveSmart throw with a select-models hint when pointer is unset", () => {
  const cfg: Config = {
    exec_cli_alias: { "opus-max": "claude --model opus {prompt}" },
    pool_caps: { default: 4 },
    default_alias: "opus-max",
  };
  expect(() => resolveFast(cfg)).toThrow("/select-models");
  expect(() => resolveSmart(cfg)).toThrow("/select-models");
});

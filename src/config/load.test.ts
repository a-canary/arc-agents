import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  resolveAlias,
  getAliasCommands,
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

test("resolveAlias returns the primary command of a known alias group", () => {
  const cfg = loadConfig(repoRoot);
  // `smart` is a retired alias name; both calls fall back to default_alias,
  // so resolveAlias must return the first candidate of that fallback group.
  const cmd = resolveAlias("smart", cfg);
  expect(cmd).toBe(getAliasCommands("smart", cfg)[0]!);
  expect(cmd).toContain("{prompt}");
});

test("getAliasCommands returns the full ordered failover group", () => {
  const cfg = loadConfig(repoRoot);
  // Current routing (direct provider, captain standing plan 2026-08-27):
  // `planning` is a single Veles workhorse command. A retired alias name
  // (e.g. `minimax-build`, still referenced by row markers) falls back to
  // default_alias.
  const cmds = getAliasCommands("planning", cfg);
  expect(cmds).toHaveLength(1);
  expect(cmds[0]).toContain("pi --model Veles/unsloth/Qwen3.8-27B-GGUF");
  expect(cmds[0]).toContain("{prompt}");
  // `hard` is the escalation group: claude-afk opus first, Veles fallback.
  const hard = getAliasCommands("hard", cfg);
  expect(hard).toHaveLength(2);
  expect(hard[0]!).toContain("claude-afk --model opus");
  expect(hard[1]!).toContain("pi --model Veles/unsloth/Qwen3.8-27B-GGUF");
  expect(getAliasCommands("minimax-build", cfg)).toEqual(
    getAliasCommands(cfg.default_alias, cfg),
  );
});

test("getAliasCommands normalizes a bare-string alias to a one-element group", () => {
  const cfg: Config = {
    exec_cli_alias: { solo: "claude --model opus {prompt}" },
    pool_caps: { default: 4 },
    default_alias: "solo",
  };
  expect(getAliasCommands("solo", cfg)).toEqual([
    "claude --model opus {prompt}",
  ]);
});

test("resolveAlias falls back to default_alias group for unknown alias", () => {
  const cfg = loadConfig(repoRoot);
  const fallback = getAliasCommands(cfg.default_alias, cfg)[0]!;
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

test("loadConfig throws when one candidate in a group is missing {prompt}", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: {
        grp: [
          "pi -p --provider minimax --model MiniMax-M3 {prompt}",
          "claude --model opus", // missing {prompt}
        ],
      },
      pool_caps: { default: 4 },
      default_alias: "grp",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow(/grp.*\{prompt\} exactly once/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects an interactive candidate that is not last in a group", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: {
        grp: [
          "claude --model opus {prompt}", // interactive (no -p) but not last
          "pi -p --provider minimax --model MiniMax-M3 {prompt}",
        ],
      },
      pool_caps: { default: 4 },
      default_alias: "grp",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow(/interactive.*not last/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig allows an interactive candidate as the LAST group member", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const ok = {
      exec_cli_alias: {
        grp: [
          "pi -p --provider minimax --model MiniMax-M3 {prompt}",
          "claude --model opus {prompt}", // interactive, last — reachable
        ],
      },
      pool_caps: { default: 4 },
      default_alias: "grp",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(ok));
    expect(() => loadConfig(dir)).not.toThrow();
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

test("loadConfig rejects a non-Claude model on any candidate within a group", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const bad = {
      exec_cli_alias: {
        grp: [
          "claude --model opus {prompt}",
          "claude --model minimax-m2.7 {prompt}", // bad second candidate
        ],
      },
      pool_caps: { default: 4 },
      default_alias: "grp",
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
    expect(() => loadConfig(dir)).toThrow("not a known Claude model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig allows provider models via `pi -p --provider` and real claude models (incl. fable)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  try {
    const ok = {
      exec_cli_alias: {
        "claude-fable": "claude --model fable {prompt}",
        "opus-max": "claude --model opus --effort max {prompt}",
        "minimax-build":
          "pi -p --provider minimax --model MiniMax-M2.7 {prompt}",
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

test("ARC_DISABLE_CLAUDE drops claude/claude-afk candidates (ProgramBench overlay)", () => {
  const cfg: Config = {
    exec_cli_alias: {
      smart: [
        "claude-afk --model fable -p {prompt}",
        "claude-afk --model opus -p {prompt}",
        "pi -p --provider minimax --model MiniMax-M3 --thinking high {prompt}",
      ],
    },
    pool_caps: { default: 4 },
    default_alias: "smart",
  };
  const prev = process.env.ARC_DISABLE_CLAUDE;
  try {
    process.env.ARC_DISABLE_CLAUDE = "1";
    expect(getAliasCommands("smart", cfg)).toEqual([
      "pi -p --provider minimax --model MiniMax-M3 --thinking high {prompt}",
    ]);
  } finally {
    if (prev === undefined) delete process.env.ARC_DISABLE_CLAUDE;
    else process.env.ARC_DISABLE_CLAUDE = prev;
  }
});

test("ARC_DISABLE_CLAUDE throws when it empties a claude-only group", () => {
  const cfg: Config = {
    exec_cli_alias: {
      "claude-only": [
        "claude-afk --model fable -p {prompt}",
        "claude --model opus {prompt}",
      ],
    },
    pool_caps: { default: 4 },
    default_alias: "claude-only",
  };
  const prev = process.env.ARC_DISABLE_CLAUDE;
  try {
    process.env.ARC_DISABLE_CLAUDE = "1";
    expect(() => getAliasCommands("claude-only", cfg)).toThrow(
      "no runnable engine remains",
    );
  } finally {
    if (prev === undefined) delete process.env.ARC_DISABLE_CLAUDE;
    else process.env.ARC_DISABLE_CLAUDE = prev;
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

test("resolveFast / resolveSmart return alias, primary command, and full failover group", () => {
  const cfg: Config = {
    exec_cli_alias: {
      smart: [
        "claude --model fable {prompt}",
        "claude --model opus --effort max {prompt}",
      ],
      "minimax-fast":
        "pi -p --provider minimax --model MiniMax-M3 --thinking low {prompt}",
    },
    pool_caps: { default: 4 },
    default_alias: "minimax-fast",
    fast_alias: "minimax-fast",
    smart_alias: "smart",
  };
  expect(resolveFast(cfg)).toEqual({
    alias: "minimax-fast",
    command:
      "pi -p --provider minimax --model MiniMax-M3 --thinking low {prompt}",
    commands: [
      "pi -p --provider minimax --model MiniMax-M3 --thinking low {prompt}",
    ],
  });
  expect(resolveSmart(cfg)).toEqual({
    alias: "smart",
    command: "claude --model fable {prompt}",
    commands: [
      "claude --model fable {prompt}",
      "claude --model opus --effort max {prompt}",
    ],
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

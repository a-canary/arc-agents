// Copyright 2026 a-canary
// Licensed under the Apache License, Version 2.0
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ConfigSchema = z
  .object({
    exec_cli_alias: z.record(z.string(), z.string()),
    pool_caps: z.record(z.string(), z.number()),
    default_alias: z.string(),
    // Picked by the `select-models` arc-skill. Both, when present, must name a
    // key inside exec_cli_alias — they are pointers, not parallel commands.
    // Consumers (pipeliner, dream, future arc-* tooling) read these to learn
    // which of the alias map's entries are the fast and smart ones.
    fast_alias: z.string().optional(),
    smart_alias: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    for (const [alias, cmd] of Object.entries(cfg.exec_cli_alias)) {
      const count = (cmd.match(/\{prompt\}/g) ?? []).length;
      if (count !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exec_cli_alias", alias],
          message: `alias command must contain {prompt} exactly once (found ${count}): "${cmd}"`,
        });
      }
      // Guard the worker-spawn engine discriminator (worker-shell.sh): a
      // template invoking `claude` is run interactively, so its `--model` must
      // be a real Claude model alias. Routing a provider model (e.g. minimax)
      // through `claude --model` makes every spawned worker die on arrival
      // ("model may not exist") with no other guard — provider models belong
      // behind `pi -p --provider`. Surfaced by the dream failure-mining run
      // over 2026-05-27 worker sessions (5/7 dead on `claude --model minimax-m2.7`).
      const claudeModel = cmd.match(/^claude\b[^]*?--model[= ]+(\S+)/)?.[1];
      if (claudeModel && !CLAUDE_MODELS.has(claudeModel)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exec_cli_alias", alias],
          message: `alias "${alias}" runs \`claude --model ${claudeModel}\`, which is not a known Claude model (${[...CLAUDE_MODELS].join(", ")}). Provider models must run via \`pi -p --provider …\`, not \`claude --model\`.`,
        });
      }
    }
    // fast_alias / smart_alias, when set, must point at an existing entry —
    // a dangling pointer would let select-models register a stale name and
    // every downstream consumer would resolve to undefined at spawn time.
    for (const ptr of ["fast_alias", "smart_alias"] as const) {
      const v = cfg[ptr];
      if (v !== undefined && cfg.exec_cli_alias[v] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [ptr],
          message: `${ptr} "${v}" is not a key in exec_cli_alias`,
        });
      }
    }
  });

// Known Claude model aliases accepted by `claude --model`. A `claude` exec
// alias may only name one of these; anything else (provider models, typos)
// must route through `pi -p --provider`.
const CLAUDE_MODELS = new Set(["opus", "sonnet", "haiku"]);

export type Config = z.infer<typeof ConfigSchema>;

const repoRoot = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadConfig(root: string = repoRoot()): Config {
  const path = join(root, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ConfigSchema.parse(raw);
}

export function resolveAlias(aliasName: string, cfg: Config): string {
  const cmd = cfg.exec_cli_alias[aliasName];
  if (cmd !== undefined) return cmd;
  const defaultCmd = cfg.exec_cli_alias[cfg.default_alias];
  if (defaultCmd === undefined) {
    throw new Error(
      `resolveAlias: default_alias "${cfg.default_alias}" is not present in exec_cli_alias`,
    );
  }
  return defaultCmd;
}

// Resolve the fast/smart picks set by `/select-models`. Returns the alias name
// and its command. Throws when the pointer is unset — callers should treat that
// as "user has not run select-models yet" and prompt them, not silently fall
// back to default_alias (which would defeat the point of having a smart tier).
export function resolveFast(cfg: Config): { alias: string; command: string } {
  return resolvePtr(cfg, "fast_alias");
}

export function resolveSmart(cfg: Config): { alias: string; command: string } {
  return resolvePtr(cfg, "smart_alias");
}

function resolvePtr(
  cfg: Config,
  ptr: "fast_alias" | "smart_alias",
): { alias: string; command: string } {
  const alias = cfg[ptr];
  if (alias === undefined) {
    throw new Error(
      `resolve${ptr === "fast_alias" ? "Fast" : "Smart"}: ${ptr} not set in config. Run \`/select-models\` to register fast and smart picks.`,
    );
  }
  const command = cfg.exec_cli_alias[alias];
  if (command === undefined) {
    // ConfigSchema's superRefine already blocks this at load time, so the
    // throw here is for the case where someone constructs a Config in-memory
    // and bypasses the schema (tests, future callers).
    throw new Error(
      `resolve${ptr === "fast_alias" ? "Fast" : "Smart"}: ${ptr} "${alias}" is not a key in exec_cli_alias`,
    );
  }
  return { alias, command };
}

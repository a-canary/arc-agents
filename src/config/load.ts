import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ConfigSchema = z
  .object({
    exec_cli_alias: z.record(z.string(), z.string()),
    pool_caps: z.record(z.string(), z.number()),
    default_alias: z.string(),
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
    }
  });

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

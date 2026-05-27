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

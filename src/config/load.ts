import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ConfigSchema = z
  .object({
    // Each value is an alias GROUP: a single command, or an ordered failover
    // list. worker-shell.sh tries candidates in order and falls over to the
    // next when one produces no work (G-0006 two-tier → N-tier escalation).
    // A bare string is sugar for a one-element group.
    exec_cli_alias: z.record(
      z.string(),
      z.union([z.string(), z.array(z.string()).min(1)]),
    ),
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
    for (const [alias, raw] of Object.entries(cfg.exec_cli_alias)) {
      const cmds = Array.isArray(raw) ? raw : [raw];
      cmds.forEach((cmd, i) => {
        const path = Array.isArray(raw)
          ? ["exec_cli_alias", alias, i]
          : ["exec_cli_alias", alias];
        const count = (cmd.match(/\{prompt\}/g) ?? []).length;
        if (count !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `alias "${alias}" command must contain {prompt} exactly once (found ${count}): "${cmd}"`,
          });
        }
        // Guard the worker-spawn engine discriminator (worker-shell.sh): a
        // template invoking `claude` (incl. `claude-afk`, observable headless
        // claude) routes its `--model` to a real `claude` process, so the model
        // must be a real Claude model alias. Routing a provider model (e.g.
        // minimax) through `claude --model` makes the worker die on arrival
        // ("model may not exist") — provider models belong behind `pi -p
        // --provider`. Surfaced by the dream failure-mining run over 2026-05-27
        // worker sessions (5/7 dead on `claude --model minimax-m2.7`).
        const claudeModel = cmd.match(/^claude\b[^]*?--model[= ]+(\S+)/)?.[1];
        if (claudeModel && !CLAUDE_MODELS.has(claudeModel)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `alias "${alias}" runs \`claude --model ${claudeModel}\`, which is not a known Claude model (${[...CLAUDE_MODELS].join(", ")}). Provider models must run via \`pi -p --provider …\`, not \`claude --model\`.`,
          });
        }
      });
      // Ordering guard: an interactive candidate (no `-p`) exec()s in
      // worker-shell.sh and never returns, so every LATER candidate in the
      // group is unreachable. Only the last candidate may be interactive.
      if (Array.isArray(raw) && raw.length > 1) {
        raw.forEach((cmd, i) => {
          const isHeadless = cmd.split(/\s+/).includes("-p");
          if (!isHeadless && i < raw.length - 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["exec_cli_alias", alias, i],
              message: `alias "${alias}" candidate ${i} is interactive (no \`-p\`) but not last — an interactive engine exec()s and never falls over, so the ${raw.length - 1 - i} candidate(s) after it are unreachable. Put interactive engines last.`,
            });
          }
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

// Known Claude model aliases accepted by `claude --model`. A `claude` (or
// `claude-afk`) exec alias may only name one of these; anything else (provider
// models, typos) must route through `pi -p --provider`.
const CLAUDE_MODELS = new Set(["opus", "sonnet", "haiku", "fable"]);

export type Config = z.infer<typeof ConfigSchema>;

const repoRoot = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadConfig(root: string = repoRoot()): Config {
  const path = join(root, "config.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ConfigSchema.parse(raw);
}

// Normalize an alias entry (string | string[]) to the ordered candidate list.
function toGroup(raw: string | string[]): string[] {
  return Array.isArray(raw) ? raw : [raw];
}

// env flags like ARC_DISABLE_CLAUDE: present and not an explicit off-value.
function envOn(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

// Resolve an alias NAME to its ordered failover candidate list. Falls back to
// default_alias for an unknown name (back-compat with the old single-command
// resolveAlias). When ARC_DISABLE_CLAUDE is set (ProgramBench overlay: minimax
// only, no Claude usage) any `claude`/`claude-afk` candidate is dropped; if that
// empties the group it throws loudly rather than spawning a no-op worker.
export function getAliasCommands(aliasName: string, cfg: Config): string[] {
  const raw =
    cfg.exec_cli_alias[aliasName] ?? cfg.exec_cli_alias[cfg.default_alias];
  if (raw === undefined) {
    throw new Error(
      `getAliasCommands: alias "${aliasName}" not found and default_alias "${cfg.default_alias}" is not present in exec_cli_alias`,
    );
  }
  let cmds = toGroup(raw);
  if (envOn(process.env.ARC_DISABLE_CLAUDE)) {
    cmds = cmds.filter((c) => !c.trimStart().startsWith("claude"));
    if (cmds.length === 0) {
      throw new Error(
        `getAliasCommands: ARC_DISABLE_CLAUDE is set but alias "${aliasName}" has only claude/claude-afk candidates — no runnable engine remains. Add a non-claude (e.g. \`pi -p\`) candidate to this group.`,
      );
    }
  }
  return cmds;
}

// Back-compat single-command resolver: the PRIMARY (first) candidate of the
// group. Callers that want the full failover list use getAliasCommands.
export function resolveAlias(aliasName: string, cfg: Config): string {
  return getAliasCommands(aliasName, cfg)[0]!;
}

// Resolve the fast/smart picks set by `/select-models`. Returns the alias name,
// its primary command, and the full failover list. Throws when the pointer is
// unset — callers should treat that as "user has not run select-models yet" and
// prompt them, not silently fall back to default_alias (which would defeat the
// point of having a smart tier).
export function resolveFast(cfg: Config): {
  alias: string;
  command: string;
  commands: string[];
} {
  return resolvePtr(cfg, "fast_alias");
}

export function resolveSmart(cfg: Config): {
  alias: string;
  command: string;
  commands: string[];
} {
  return resolvePtr(cfg, "smart_alias");
}

function resolvePtr(
  cfg: Config,
  ptr: "fast_alias" | "smart_alias",
): { alias: string; command: string; commands: string[] } {
  const alias = cfg[ptr];
  if (alias === undefined) {
    throw new Error(
      `resolve${ptr === "fast_alias" ? "Fast" : "Smart"}: ${ptr} not set in config. Run \`/select-models\` to register fast and smart picks.`,
    );
  }
  if (cfg.exec_cli_alias[alias] === undefined) {
    // ConfigSchema's superRefine already blocks this at load time, so the
    // throw here is for the case where someone constructs a Config in-memory
    // and bypasses the schema (tests, future callers).
    throw new Error(
      `resolve${ptr === "fast_alias" ? "Fast" : "Smart"}: ${ptr} "${alias}" is not a key in exec_cli_alias`,
    );
  }
  const commands = getAliasCommands(alias, cfg);
  return { alias, command: commands[0]!, commands };
}

// UX Module Contract — config loader + bookie HITL validator.
// See ADR 0002 (U-0001, U-0005). Config declares verbs + render strategies;
// ledger heartbeats hold liveness. This module is the join point.

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { hitlKind, type HitlKind } from "./hitl-schemas";
import type { ValidationError } from "./bookie-validator";

const RENDER_STRATEGY = z.enum([
  "native",
  "rasterize-png",
  "ascii-degrade",
  "link-out",
  "unsupported",
]);
export type RenderStrategy = z.infer<typeof RENDER_STRATEGY>;

const ARTIFACT_TYPE = z.enum([
  "text/markdown",
  "text/diff",
  "chart/vega-lite",
  "diagram/mermaid",
  "image/png",
  "table/rows",
]);
export type ArtifactType = z.infer<typeof ARTIFACT_TYPE>;

const moduleSchema = z.object({
  cli: z.string().optional(),
  pusher: z.string().optional(),
  implements: z.array(hitlKind).default([]),
  renders: z.record(ARTIFACT_TYPE, RENDER_STRATEGY).default({}),
  can_retract: z.boolean().default(false),
});
export type UxModule = z.infer<typeof moduleSchema> & { name: string };

const configSchema = z.object({
  modules: z.record(z.string(), moduleSchema).default({}),
});
export type UxConfig = z.infer<typeof configSchema>;

export function defaultConfigPath(): string {
  if (process.env.ARC_CONFIG) return process.env.ARC_CONFIG;
  const home = process.env.HOME ?? "";
  return `${home}/.config/arc/config.yaml`;
}

export function loadConfig(path: string = defaultConfigPath()): UxConfig {
  if (!existsSync(path)) return { modules: {} };
  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  return configSchema.parse(raw);
}

// Pinned per CHOICES U-0009. Schema mirrors these in system/config-schema.json.
// interval_sec=60 (cheap, leaves headroom over arc-tui-loop's 30s tick).
// stale_after_sec=300 (survives one missed beat + cron drift; bounces wedged
// pushers before HITL retries pile up).
export const HEARTBEAT_DEFAULTS = {
  interval_sec: 60,
  stale_after_sec: 300,
} as const;

export function aliveModuleNames(
  db: Database,
  staleSec: number = HEARTBEAT_DEFAULTS.stale_after_sec,
): string[] {
  const cutoff = Math.floor(Date.now() / 1000) - staleSec;
  return db
    .query<{ module_name: string }, [number]>(
      "SELECT module_name FROM ux_heartbeats WHERE last_beat > ?",
    )
    .all(cutoff)
    .map((r) => r.module_name);
}

export type ModuleAliveness = {
  module_name: string;
  last_beat: number;
  alive: boolean;
};

// SQL-joined alive set: every module that has ever beat, with current liveness
// decision baked in. Backs `bin/ledger.ts list-alive-modules` (U-0009) so
// callers stop reimplementing the threshold compare.
export function aliveModulesDetail(
  db: Database,
  staleSec: number = HEARTBEAT_DEFAULTS.stale_after_sec,
): ModuleAliveness[] {
  const cutoff = Math.floor(Date.now() / 1000) - staleSec;
  return db
    .query<{ module_name: string; last_beat: number }, []>(
      "SELECT module_name, last_beat FROM ux_heartbeats ORDER BY module_name",
    )
    .all()
    .map((r) => ({
      module_name: r.module_name,
      last_beat: r.last_beat,
      alive: r.last_beat > cutoff,
    }));
}

export function pickModulesForHitl(db: Database, cfg: UxConfig, kind: HitlKind): UxModule[] {
  const alive = new Set(aliveModuleNames(db));
  const out: UxModule[] = [];
  for (const [name, mod] of Object.entries(cfg.modules)) {
    if (!alive.has(name)) continue;
    if (!mod.implements.includes(kind)) continue;
    out.push({ ...mod, name });
  }
  return out;
}

export type HitlWriteInput = {
  kind: HitlKind;
  artifacts?: { type: string }[];
};

// A render strategy "renders" the artifact if it's not 'unsupported' and not missing.
function rendersArtifact(mod: UxModule, type: string): boolean {
  const s = mod.renders[type as ArtifactType];
  return s !== undefined && s !== "unsupported";
}

export function validateHitlWrite(
  db: Database,
  cfg: UxConfig,
  input: HitlWriteInput,
): ValidationError[] {
  const errs: ValidationError[] = [];
  const candidates = pickModulesForHitl(db, cfg, input.kind);
  if (candidates.length === 0) {
    errs.push({
      field: "kind",
      message: `no alive UX module implements '${input.kind}'. Install or revive one (ADR 0002).`,
    });
    return errs;
  }
  for (const art of input.artifacts ?? []) {
    const anyRenders = candidates.some((m) => rendersArtifact(m, art.type));
    if (!anyRenders) {
      errs.push({
        field: "artifacts",
        message: `no alive module renders artifact type '${art.type}' for verb '${input.kind}'`,
      });
    }
  }
  return errs;
}

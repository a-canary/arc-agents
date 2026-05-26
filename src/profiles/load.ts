import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ProfileSchema = z.object({
  agent: z.string(),
  context_summary: z.string(),
  context_files: z.array(z.string()).default([]),
  boot_skills: z.array(z.string()),
  stop_skills: z.array(z.string()),
  exec_cli_alias: z.string(),
  max_concurrency: z.number().int().positive(),
  worktree: z.boolean(),
});

export type Profile = z.infer<typeof ProfileSchema>;

const repoRoot = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadProfile(agent: string, root: string = repoRoot()): Profile {
  const path = join(root, "profiles", `${agent}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ProfileSchema.parse(raw);
}

export function loadAll(root: string = repoRoot()): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  for (const agent of ["developer", "director", "admin", "sprint", "triage"]) {
    out[agent] = loadProfile(agent, root);
  }
  return out;
}

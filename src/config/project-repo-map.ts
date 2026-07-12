// Shared project -> repo map (JSON, read by both this TS loader and
// bin/worker-shell.sh's bash parser — keep the format flat/simple so the bash
// side can parse it with grep/sed, no jq dependency).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProjectRepoEntry = { repo?: string; parked?: boolean };

const MAP_PATH = join(import.meta.dir, "project-repo-map.json");

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p;
}

export function loadProjectRepoMap(): Record<string, ProjectRepoEntry> {
  try {
    return JSON.parse(readFileSync(MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Precedence: ARC_PROJECT_REPO_<UPPER> env override > shared map entry >
// implicit ~/repos/<project> if it exists on disk > null (refuse to mint).
export function resolveProjectRepo(project: string): string | null {
  const override = process.env[`ARC_PROJECT_REPO_${project.toUpperCase().replace(/-/g, "_")}`];
  if (override) return override;

  const entry = loadProjectRepoMap()[project];
  if (entry?.repo) return expandHome(entry.repo);
  if (entry?.parked) return null; // parked with no repo yet — unroutable by design

  const implicit = join(process.env.HOME ?? "", "repos", project);
  return existsSync(implicit) ? implicit : null;
}

export function isParkedProject(project: string): boolean {
  return loadProjectRepoMap()[project]?.parked === true;
}

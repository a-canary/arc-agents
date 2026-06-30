import { homedir } from "node:os";
import { resolve } from "node:path";

export type Role = "admin" | "director" | "developer";

export interface SelectOptions {
  home?: string;
}

/**
 * Role selection by cwd per A-0003 / CLAUDE.md:
 *   1. ~/vault/agents/admin/            → admin
 *   2. ~/vault/agents/directors/<group>/ → director (per-group Director home, PLURAL)
 *   3. ~/vault/agents/director/         → director (legacy SINGULAR, back-compat)
 *   4. ~/worktrees/<repo>-*\/            → developer
 *   5. ~/repos/<name>/                  → developer
 *   6. fallback                         → director
 *
 * Under A-0003 each project group gets its own Director home at
 * ~/vault/agents/directors/<group>/ (e.g. directors/onenation, directors/trading).
 * Use directorGroupFromCwd() to extract the <group> segment.
 */
export function selectRoleByCwd(cwd: string, opts: SelectOptions = {}): Role {
  const home = opts.home ?? homedir();
  const norm = resolve(cwd);
  const prefix = (p: string) => resolve(home, p);

  const adminRoot = prefix("vault/agents/admin");
  const directorsRoot = prefix("vault/agents/directors");
  const directorRoot = prefix("vault/agents/director");
  const worktreesRoot = prefix("worktrees");
  const reposRoot = prefix("repos");

  if (isWithin(norm, adminRoot)) return "admin";
  if (isWithin(norm, directorsRoot)) return "director";
  if (isWithin(norm, directorRoot)) return "director";
  if (isWithin(norm, worktreesRoot)) return "developer";
  if (isWithin(norm, reposRoot)) return "developer";
  return "director";
}

/**
 * The <group> segment when cwd is within ~/vault/agents/directors/<group>/
 * (one or more segments deep), else null. A-0003 per-group Director home.
 */
export function directorGroupFromCwd(cwd: string, opts: SelectOptions = {}): string | null {
  const home = opts.home ?? homedir();
  const norm = resolve(cwd);
  const directorsRoot = resolve(home, "vault/agents/directors");

  if (!isWithin(norm, directorsRoot) || norm === directorsRoot) return null;
  const rest = norm.slice(directorsRoot.length + 1); // strip "directors/"
  const group = rest.split("/")[0] ?? "";
  return group.length > 0 ? group : null;
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const sep = parent.endsWith("/") ? "" : "/";
  return child.startsWith(parent + sep);
}

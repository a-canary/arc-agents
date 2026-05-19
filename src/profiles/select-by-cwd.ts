import { homedir } from "node:os";
import { resolve } from "node:path";

export type Role = "admin" | "director" | "developer";

export interface SelectOptions {
  home?: string;
}

/**
 * Role selection by cwd per A-0003 / CLAUDE.md:
 *   1. ~/vault/agents/admin/        → admin
 *   2. ~/vault/agents/director/     → director
 *   3. ~/worktrees/<repo>-*\/        → developer
 *   4. ~/repos/<name>/              → developer
 *   5. fallback                     → director
 */
export function selectRoleByCwd(cwd: string, opts: SelectOptions = {}): Role {
  const home = opts.home ?? homedir();
  const norm = resolve(cwd);
  const prefix = (p: string) => resolve(home, p);

  const adminRoot = prefix("vault/agents/admin");
  const directorRoot = prefix("vault/agents/director");
  const worktreesRoot = prefix("worktrees");
  const reposRoot = prefix("repos");

  if (isWithin(norm, adminRoot)) return "admin";
  if (isWithin(norm, directorRoot)) return "director";
  if (isWithin(norm, worktreesRoot)) return "developer";
  if (isWithin(norm, reposRoot)) return "developer";
  return "director";
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const sep = parent.endsWith("/") ? "" : "/";
  return child.startsWith(parent + sep);
}

// cross-repo-gate.ts — KE Pattern A gate (failures/2026-07-13-cross-repo-
// dispatch-webui-task-arc-agents, second occurrence: webui-arc-context-
// proxy-tradeoff-surface). A ready row whose title/body explicitly targets
// another known project's GitHub repo — while its own repo slug appears
// nowhere — is likely mis-routed: a worker claiming it lands in the wrong
// worktree and can only fail with routing-mismatch evidence.
//
// The gate does NOT silently re-route (deterministic text heuristics cannot
// distinguish "work in repo X" from "work about repo X"). It parks the row
// hitl=1 with a note event; the existing gate-triage arm (ready+hitl=1
// tasks >2h → opus judge) adjudicates: auto verdict lifts the park, human
// verdict keeps it. A `cross-repo-gate` event marks the row so an opus
// unpark is never re-parked (no park/unpark loop).
//
// ponytail: mention-based heuristic, false positives cost one 2h park +
// one opus call; upgrade to an explicit `target-repo:` body marker if
// minting ever emits one. Known false-positive class for the title-prefix
// arm: an arc-agents row titled "webui: ..." that really targets arc-agents'
// own bin/webui-server.ts. One opus unpark settles it permanently (the
// cross-repo-gate event bars re-parking).

import type { Database } from "bun:sqlite";
import { PROJECT_GH_REPO } from "./merge-guard";

const REPO_TO_PROJECT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROJECT_GH_REPO).map(([p, r]) => [r.toLowerCase(), p]),
);

// Bare-name lookup: project key AND github repo basename both resolve to the
// project. Minted titles use the short name ("webui: ...", "ke: ..."), never
// the full `a-canary/<repo>` slug — the motivating row
// (webui-arc-context-proxy-tradeoff-surface, title "webui: ...") mentions no
// slug at all, so slug-only matching missed the very incident this gate exists
// for.
const NAME_TO_PROJECT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PROJECT_GH_REPO).flatMap(([p, r]) => [
    [p.toLowerCase(), p],
    [r.split("/")[1]!.toLowerCase(), p],
  ]),
);

/**
 * Returns the project whose repo the row's text targets, or null when the
 * row looks correctly routed. Fires only when exactly one foreign known
 * repo slug (`a-canary/<repo>`) is mentioned AND the row's own repo slug
 * is absent — zero mentions, own-repo mentions, ambiguous multi-repo
 * mentions, and unknown slugs all return null (claim proceeds).
 */
export function detectCrossRepoTarget(
  project: string | null | undefined,
  title: string,
  body: string | null | undefined,
): string | null {
  if (!project) return null;
  const own = PROJECT_GH_REPO[project]?.toLowerCase();
  const text = `${title}\n${body ?? ""}`.toLowerCase();
  if (own && text.includes(own)) return null;
  const targets = new Set<string>();
  for (const m of text.matchAll(/a-canary\/([\w.-]+?)(?:\.git)?(?=[^\w.-]|$)/g)) {
    const p = REPO_TO_PROJECT[`a-canary/${m[1]}`];
    if (p && p !== project) targets.add(p);
  }
  if (targets.size === 1) return [...targets][0]!;
  if (targets.size > 1) return null;
  return detectTitlePrefixTarget(project, title, own);
}

// Minting convention: a title prefixed `<project-or-repo-name>:` names the
// target project. Fires only when that name resolves to a known project other
// than the row's own — hygiene-skill prefixes ("improve-architecture:",
// "clarify-docs:") resolve to nothing and are ignored.
function detectTitlePrefixTarget(
  project: string,
  title: string,
  own: string | undefined,
): string | null {
  const m = /^\s*([\w.-]+)\s*:/.exec(title);
  if (!m) return null;
  const target = NAME_TO_PROJECT[m[1]!.toLowerCase()];
  if (!target || target === project) return null;
  // Own project named anywhere in the title still means "correctly routed".
  if (own && title.toLowerCase().includes(own.split("/")[1]!)) return null;
  return target;
}

export type CrossRepoParked = { id: string; project: string; target: string };

/**
 * Factory-tick sweep: park every ready hitl=0 task the detector flags.
 * Rows already carrying a cross-repo-gate event are skipped forever —
 * gate-triage's opus unpark is final.
 */
export function sweepCrossRepoGate(db: Database): CrossRepoParked[] {
  const rows = db
    .query<{ id: string; project: string; title: string; body_md: string | null }, []>(
      `SELECT id, project, title, body_md FROM issues
       WHERE state='ready' AND hitl=0 AND kind='task'`,
    )
    .all();
  const parked: CrossRepoParked[] = [];
  for (const r of rows) {
    const target = detectCrossRepoTarget(r.project, r.title, r.body_md);
    if (!target) continue;
    const seen = db
      .query(`SELECT 1 FROM issue_events WHERE issue_id=? AND agent='cross-repo-gate' LIMIT 1`)
      .get(r.id);
    if (seen) continue;
    db.query(`UPDATE issues SET hitl=1, updated_at=strftime('%s','now') WHERE id=? AND state='ready'`).run(r.id);
    db.query(
      `INSERT INTO issue_events (issue_id, ts, agent, kind, payload_md)
       VALUES (?, strftime('%s','now'), 'cross-repo-gate', 'note', ?)`,
    ).run(
      r.id,
      `hitl-parked by cross-repo-gate: row project='${r.project}' but text targets ` +
        `${PROJECT_GH_REPO[target]} (project='${target}') and never mentions ` +
        `${PROJECT_GH_REPO[r.project] ?? r.project}. KE Pattern A ` +
        `(cross-repo dispatch). gate-triage adjudicates: re-route project to ` +
        `'${target}' if the work lives there, else unpark (auto verdict lifts hitl).`,
    );
    parked.push({ id: r.id, project: r.project, target });
  }
  return parked;
}

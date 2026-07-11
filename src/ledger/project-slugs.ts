// project-slugs.ts — phase 1 cleanup of mixed-case project slugs in the
// issues table. The arc-webui home tile counts DISTINCT projects; five
// dupe-families (Trading/Conjecture/Starlight-SLM/OurNation/webui) inflate the
// count by 5 because each has both mixed-case and lower-case variants.
//
// This function is idempotent: running it on a canonicalised DB affects 0 rows.
// It is data-only (UPDATE); no DDL, no schema migration needed.
//
// Out of scope (phase 2/3): pi-* / cc / arc-framework cleanup, blog table
// still carries mixed-case Starlight-SLM (issues-only by design), mixed-case
// validator guard.

import type { Database } from "bun:sqlite";

export interface DedupeResult {
  /** Total rows touched across both UPDATE statements. */
  affected: number;
  /** Lower-cased mixed-case rows. */
  lowerCased: number;
  /** webui → arc-webui prefix migration. */
  prefixedToArcWebui: number;
}

/**
 * Normalise the 5 known dupe-families to their canonical form:
 *   Trading|Conjecture|Starlight-SLM        → lower-case ASCII form
 *   OurNation                                → 'onenation'  (explicit, LOWER
 *                                              would yield 'ournation', which
 *                                              does NOT match the existing
 *                                              canonical form. Per phase-1
 *                                              PRD: collapse to 'onenation'.)
 *   webui                                    → 'arc-webui'  (prefix migration,
 *                                              not just case)
 *
 * Both UPDATEs use WHERE shapes that match only the mixed-case / legacy
 * variants, so running twice is a no-op (second pass matches 0 rows because
 * every legacy variant was already collapsed to the canonical form on the
 * first pass).
 */
export function dedupeProjectSlugs(db: Database): DedupeResult {
  // One UPDATE per family. Each is idempotent because the WHERE clause only
  // matches mixed-case / legacy strings.
  const trading = db.run(
    `UPDATE issues SET project = 'trading' WHERE project = 'Trading'`,
  ).changes;
  const conjecture = db.run(
    `UPDATE issues SET project = 'conjecture' WHERE project = 'Conjecture'`,
  ).changes;
  const starlight = db.run(
    `UPDATE issues SET project = 'starlight-slm' WHERE project = 'Starlight-SLM'`,
  ).changes;
  const ourNation = db.run(
    `UPDATE issues SET project = 'onenation' WHERE project = 'OurNation'`,
  ).changes;
  const webui = db.run(
    `UPDATE issues SET project = 'arc-webui' WHERE project = 'webui'`,
  ).changes;
  const lowerCased = trading + conjecture + starlight + ourNation;
  return {
    affected: lowerCased + webui,
    lowerCased,
    prefixedToArcWebui: webui,
  };
}

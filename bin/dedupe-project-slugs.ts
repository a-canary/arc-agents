#!/usr/bin/env bun
// bin/dedupe-project-slugs.ts — one-shot phase 1 cleanup for the mixed-case
// project slugs (Trading/Conjecture/Starlight-SLM/OurNation/webui). Idempotent:
// safe to re-run.
//
// Usage:
//   bun bin/dedupe-project-slugs.ts
//   bun bin/dedupe-project-slugs.ts /path/to/ledger.db

import { Database } from "bun:sqlite";
import { dedupeProjectSlugs } from "../src/ledger/project-slugs";

const dbPath = process.argv[2] ?? `${process.env.HOME}/vault/ledger.db`;
const db = new Database(dbPath);

const before = db
  .query<{ n: number }, []>("SELECT COUNT(DISTINCT project) AS n FROM issues")
  .get();

const result = dedupeProjectSlugs(db);

const after = db
  .query<{ n: number }, []>("SELECT COUNT(DISTINCT project) AS n FROM issues")
  .get();

console.log(
  JSON.stringify(
    {
      db: dbPath,
      before_distinct_projects: before?.n,
      after_distinct_projects: after?.n,
      delta: (before?.n ?? 0) - (after?.n ?? 0),
      ...result,
    },
    null,
    2,
  ),
);

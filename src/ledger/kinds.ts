// Single source of truth for issue-kind categorisation.
//
// The schema's CHECK constraint (src/ledger/migrate.ts) admits:
//   task, event, reply, prd, prefetch
//
// `CLAIMABLE_KINDS` is the set the factory's atomic claim accepts. Any new
// kind defaults to NON-claimable unless explicitly added here — safer than
// inverting via NOT IN, where forgetting to update the literal silently
// causes the factory to claim rows it can't handle.
//
// `PARKED_KINDS` are ready rows that are non-claimable BY DESIGN (e.g. PRDs
// are product specs parked indefinitely for human reference). They are
// excluded from the `unclaimable_ready` warn so they don't generate
// log-spam — the warn is meant to surface stuck transient artifacts like
// `reply` / `prefetch` rows, not parked product docs.

export const CLAIMABLE_KINDS = ["task", "event"] as const;
export type ClaimableKind = (typeof CLAIMABLE_KINDS)[number];

export const PARKED_KINDS = ["prd"] as const;
export type ParkedKind = (typeof PARKED_KINDS)[number];

// SQL fragments — quoted, comma-joined for use in `IN (...)` clauses.
// Hand-rolled rather than prepared params so the literal can be inlined
// into composed SQL alongside other clauses without param renumbering.
export const CLAIMABLE_KINDS_SQL = CLAIMABLE_KINDS.map((k) => `'${k}'`).join(",");
export const PARKED_KINDS_SQL = PARKED_KINDS.map((k) => `'${k}'`).join(",");

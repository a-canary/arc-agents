# Decision: Trash-Sweep Test Fixture — Dynamic `FUTURE_SWEEP_AFTER` to Prevent Fixture Rot

**Date:** 2026-08-04
**Status:** accepted
**Row:** `clarify-docs-trash-sweep-fixture-sweep-a`
**Source:** `bin/trash-sweep.test.ts:49` ponytail annotation
**Observed in:** `000242-hygiene-arc-agents-ponytail-audit`

---

## TL;DR

The `FUTURE_SWEEP_AFTER` fixture in `trash-sweep.test.ts` is computed
dynamically (5 years from wall-clock) so it always represents a
*not-yet‑reached* sweep date. A hardcoded literal would rot once
wall-clock passes it, turning the "files with sweep_after in the future
are kept" test from a pass to a fail without any code change.

---

## Problem

`bin/trash-sweep.test.ts` has two fixture sets:

| Fixture | `sweep_after` | Semantics |
|---|---|---|
| `TTL_PAST` | `20260501` (hardcoded) | Past deadline → file should be swept |
| `TTL_FUTURE` | `FUTURE_SWEEP_AFTER` (dynamic) | Future deadline → file should be kept |

`TTL_PAST` is safe to hardcode: it represents a deadline that must
already be past. As long as `2026-05-01` is before today, the fixture
is correct, and it will remain correct forever.

`TTL_FUTURE` is the rot hazard: its `sweep_after` must be strictly
*ahead* of wall-clock. Every test using `TTL_FUTURE` (the "future
sweep_after" test and the mixed-batch test) would silently fail if
wall-clock caught up to the literal. The ponytail annotation warns:
"sweep_after must stay ahead of wall-clock or this fixture rots."

## Solution

`FUTURE_SWEEP_AFTER` is an IIFE that computes a UTC date string 5 years
from `new Date()`:

```ts
const FUTURE_SWEEP_AFTER = (() => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 5);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
})();
```

Key properties:

1. **UTC-relative.** Uses `setUTCFullYear` / `getUTCMonth` / `getUTCDate`,
   matching the `trash-sweep.ts` `isPast()` comparison which also operates
   in UTC. Avoids timezone-dependent midnight rollover.

2. **5-year safety margin.** Long enough to survive years of subsequent
   test runs; short enough that the template literal is human-readable
   for debugging.

3. **Computed once at module load.** The IIFE runs at import time, so
   `TTL_FUTURE` is a single stable string across all tests in the file.
   No per-test re-evaluation.

## Why not alternatives

- **A hardcoded far-future literal** (e.g. `20991231`) is simpler but
  rots into a past date given enough time and is indistinguishable from
  a typo. The dynamic computation self-documents its intent.

- **A fixture generator function** called per-test would be more flexible
  but adds boilerplate and risks accidental date skew between tests that
  share the same `TTL_FUTURE` value. A module-level constant ensures all
  tests see the same value in the same run.

- **A mock `Date` or time-travel helper** is over-engineering for one
  fixture. The dynamic IIFE is a one-liner with no infrastructure.

## Cross-references

- `bin/trash-sweep.test.ts` — `TTL_PAST` (line 35), `FUTURE_SWEEP_AFTER`
  (line 50), `TTL_FUTURE` (line 56)
- `bin/trash-sweep.ts` — `isPast()` (line 92), the comparator that uses
  `Date.UTC` for timezone-independent past/future determination
- `000242-hygiene-arc-agents-ponytail-audit` — the hygiene run that
  surfaced this as unregistered design knowledge

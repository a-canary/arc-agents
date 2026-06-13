---
name: bookie-tdd
description: "TDD template for bookie subagent tasks. Covers pure-validator TDD, fixture patterns, table-driven cases, and the red-green-refactor loop specific to ledger write validation."
---

# bookie-tdd — TDD Template for Bookie Tasks

Use when adding or changing bookie validation rules, ledger write contracts, or bookie subagent logic. Applies to any task touching `src/ledger/bookie-validator.ts`, `src/ledger/kinds.ts`, `src/ledger/merge-guard.ts`, or any other pure-validator module in `src/ledger/`.

## Guiding principle

**Pure functions, no DB.** Bookie validators are total functions over inputs. They take typed arguments and return typed errors or void. They never touch `~/vault/ledger.db`. This makes them trivially testable: one `describe`/`test` block, one `expect()` per assertion, no setup/teardown.

When the logic is pure, TDD is cheap. Write the failing test first.

## Red-green-refactor loop for bookie tasks

### Phase 1 — Red: write the failing acceptance test

The test encodes a **behavior** (not an implementation). It lives in `src/ledger/<module>.test.ts` alongside the module under test.

For a new validator:

```typescript
import { test, expect } from "bun:test";
import { validateBookieWrite, type BookieWriteInput } from "./bookie-validator";

// ── new behavior ────────────────────────────────────────────────────────────
test("validateBookieWrite: rejects kind='sprint' without source_module", () => {
  const errs = validateBookieWrite(
    { kind: "sprint", class: "ops", urgency: "nominal", class_rationale: "test" },
    new Set(["arc-chat"]),
  );
  expect(errs.some((e) => e.field === "source_module")).toBe(true);
});
```

For a new enum value:

```typescript
// See src/ledger/bookie-validator.test.ts — enum exhaustiveness pattern.
test("KIND_VALUES includes 'sprint'", () => {
  expect(KIND_VALUES as readonly string[]).toContain("sprint");
});
```

For a regression case (pattern from production failure):

```typescript
// Fixture: the row that triggered the bug in analyse-recent-sessions 000031.
// Mirror exactly — project, pr_url, field names.
const CLI_PROXY_WRONG_REPO_ROW = {
  project: "cli-proxy",
  pr_url: "https://github.com/a-canary/arc-agents/pull/197",
};

test("checkMergeGuard: refuses project=cli-proxy with pr_url pointing at arc-agents", () => {
  const refusal = checkMergeGuard(CLI_PROXY_WRONG_REPO_ROW.project, CLI_PROXY_WRONG_REPO_ROW.pr_url);
  expect(refusal).not.toBeNull();
  expect(refusal).toContain("a-canary/cli-proxy"); // expected
  expect(refusal).toContain("a-canary/arc-agents"); // actual
});
```

### Phase 2 — Green: make it pass with minimal code

```typescript
// src/ledger/bookie-validator.ts — add 'sprint' to KIND_VALUES.
export const KIND_VALUES = [
  "task", "event", "reply", "prd", "prefetch", "sprint", // ← added
] as const;
```

Or for a new validator:

```typescript
export function validateBookieWrite(row, registry) {
  const errs: ValidationError[] = [];
  // ...existing checks...
  const needsModule = row.kind === "event" || row.kind === "reply";
  if (needsModule && !row.source_module) {
    errs.push({ field: "source_module", message: `source_module required for kind='${row.kind}'` });
  }
  // ...
  return errs;
}
```

### Phase 3 — Refactor: simplify, extract, document

- Extract repeated fixture builders to `describe` block helpers.
- Add the ADR/CHOICES citation in the test comment if the behavior is policy-driven.
- Run `bun test src/ledger/<module>.test.ts` to verify nothing broke.

## Test naming convention

```
<describe group>: <unit> — <scenario>
test: <unit>: <scenario> → <expected>
```

Examples from `bookie-validator.test.ts`:
- `validateBookieWrite: valid task row`
- `validateBookieWrite: missing source_module on event`
- `KIND_VALUES includes 'sprint'`

The `describe` groups align with function names. Each test name is a complete sentence describing the behavior under test.

## Fixture patterns

### Inline fixtures (preferred)

```typescript
const REGISTRY: ModuleRegistry = new Set(["arc-chat", "arc-webui"]);

const CLI_PROXY_WRONG_REPO_ROW = {
  project: "cli-proxy",
  pr_url: "https://github.com/a-canary/arc-agents/pull/197",
};
```

No external fixture files. Fixtures live at the top of the test file or inside the `describe` block.

### Table-driven cases

```typescript
type Case = {
  name: string;
  row: BookieWriteInput;
  expectField: string | null; // null = valid
};

const CASES: Case[] = [
  { name: "valid task row", row: { kind: "task", class: "MVP", urgency: "nominal", class_rationale: "x" }, expectField: null },
  { name: "bad kind", row: { kind: "weird", class: "MVP", urgency: "nominal", class_rationale: "x" }, expectField: "kind" },
  // ...
];

for (const c of CASES) {
  test(`validateBookieWrite: ${c.name}`, () => {
    const errs = validateBookieWrite(c.row, REGISTRY);
    if (c.expectField === null) {
      expect(errs).toEqual([]);
    } else {
      expect(errs.some((e) => e.field === c.expectField)).toBe(true);
    }
  });
}
```

Use table-driven cases when testing N variants of the same check (enum exhaustiveness, boundary values, error field targeting).

### Builder helpers inside `describe`

```typescript
describe("checkDuplicate", () => {
  const ready = (id: string, title: string, extra: Partial<ExistingRow> = {}): ExistingRow => ({
    id, title, tier: "hygiene", state: "ready", skill: null, ...extra,
  });

  test("exact normalized match → duplicate (exact)", () => {
    const rows = [ready("i-1", "clarify-docs: Foo Bar!")];
    expect(checkDuplicate("clarify-docs", "clarify-docs: foo bar", rows)).toEqual({ duplicate: true, existingId: "i-1", reason: "exact" });
  });
});
```

Use builder helpers when tests share a base row shape but vary one field.

## What to test

### `validateBookieWrite` (primary bookie validator)

| Scenario | Expected |
|---|---|
| Valid task row | No errors |
| Valid event row with known `source_module` | No errors |
| Valid `class_unset` + `triage_pending` | No errors |
| Unknown `kind` | `field: "kind"` error |
| Unknown `class` (or `tier`) | `field: "tier"` error |
| Unknown `pool` (or `urgency`) | `field: "pool"` error |
| `class_unset` without `triage_pending` | `field: "tier"` error |
| `event` or `reply` without `source_module` | `field: "source_module"` error |
| `source_module` not in registry | `field: "source_module"` error |
| Missing `class_rationale` | `field: "class_rationale"` error |

### `validateCreate` (CLI-surface validator)

| Scenario | Expected |
|---|---|
| Positional args | `field: "args"` error |
| Flag-only args with valid enums | No errors |
| Title that looks like a flag | `field: "--title"` error |
| Unknown `kind` | `field: "--kind"` error |
| Unknown `type` | `field: "--type"` error |
| Malformed `blockedBy` | `field: "--blocked-by"` error |
| All enum values accepted | No errors per value |

### `validateStateTransition`

| Scenario | Expected |
|---|---|
| `merged` → `ready` | Blocked (terminal) |
| `cancelled` → any | Blocked (terminal) |
| `ready` → `claimed` | Allowed |
| `claimed` → `wip` | Allowed |
| Same-state transition | Allowed (no-op) |

### `validateDecompose`

| Scenario | Expected |
|---|---|
| Missing `parent` | `field: "parent"` error |
| No children | `field: "--child"` error |
| Fanout > 5 | `field: "--child"` error + message mentions cap |
| Child title that looks like a flag | `field: "--child"` error |

### Merge-guard (`checkMergeGuard`, `parsePrRepo`)

| Scenario | Expected |
|---|---|
| Known project + correct repo | No error |
| `project=cli-proxy` + `pr_url` → `arc-agents` | Refusal (Pattern 1 regression) |
| Null/empty `pr_url` | Null (short-circuit) |
| Non-PR URL | Null (short-circuit) |

### Enum exhaustiveness

```typescript
test("all KIND_VALUES accepted by validateCreate", () => {
  for (const k of KIND_VALUES) {
    expect(validateCreate({ title: "ok", kind: k, type: "mvp" })).toEqual([]);
  }
});
```

Run this pattern whenever an enum is added or renamed. It is the cheapest regression test you can write.

## What NOT to test

- **DB-side CHECK constraints.** These are exercised by `bin/ledger.test.ts` (integration). Bookie-validator tests are pure unit tests.
- **CLI argument parsing.** That belongs in `bin/ledger.test.ts`. Bookie-validator tests pass already-parsed `CreateInput` objects.
- **Side effects.** Bookie validators are pure. If a test needs to mock a DB, the function being tested is in the wrong layer — split it.

## Running tests

```bash
bun test src/ledger/bookie-validator.test.ts          # single module
bun test src/ledger/bookie-validator.test.ts -t "sprint"  # filter by name
bun test src/ledger/                                  # all ledger tests
bun run typecheck                                     # tsc --noEmit
```

## Diff-review gate

Before merging a bookie-task PR, the reviewer checks:
1. New behavior is covered by at least one failing test in the diff.
2. Enum additions have an exhaustiveness test.
3. Regression cases cite the `analyse-recent-sessions` entry or ADR that motivated them.
4. No DB access in test files (pure functions only).

> **Note:** This template gives inline examples per function. It does not include a
> single end-to-end walkthrough (all phases on one feature). Workers may use
> `src/ledger/bookie-validator.test.ts` as the canonical full-phase reference instead.

## Related

- [[bookie]] — the subagent this template serves.
- [[tdd]] — general TDD loop (red-green-refactor, integration vs unit).
- [[replay-shadow]] — confidence primitive for skill/prompt changes, not unit tests.
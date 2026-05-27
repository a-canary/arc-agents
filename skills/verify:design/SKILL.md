---
name: verify:design
description: "Validate design doc structural completeness and cross-reference integrity. Returns a structured pass/fail report per criterion."
---

# verify:design — Design Document Validation Harness

Accepts a design document path, runs structural checks, and returns a machine-readable report.

## When to use

- After drafting a design.md and before filing as evidence
- When the user says `/verify:design` or asks "validate this design doc"

## Check families

### 1. Section completeness

Required sections (case-insensitive):

| Section | Weight |
|---|---|
| Overview / Purpose | required |
| Architecture / Data Model | required |
| API / Interface | required |
| Edge cases | recommended |
| Open questions | recommended |

### 2. Reference validation

Mirrors `verify:plan` reference check. Must check local file paths and HTTP links.

### 3. Assumption surfacing

Mirrors `verify:plan` assumption extraction.

## Output schema

```json
{
  "design_path": "/path/to/design.md",
  "overall": "pass" | "warn" | "fail",
  "sections": [...],
  "references": [...],
  "assumptions": [...],
  "summary": {
    "sections_passed": N,
    "sections_failed": N,
    "refs_broken": N,
    "assumptions_found": N
  }
}
```

## Implementation

This skill reuses the same validation engine as `verify:plan` with a different
section header catalog. The skill writer imports `checkSections` from
`src/verify/plan.ts` with a `DESIGN_HEADERS` map.

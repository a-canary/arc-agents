---
name: verify:plan
description: "Validate plan.md structural completeness, reference integrity, and assumption surfacing. Returns a structured pass/fail report per criterion."
---

# verify:plan — Plan Validation Harness

Accepts a plan.md path, runs three structural check families, returns a machine-readable report.

## When to use

- After drafting a plan.md and before filing it as evidence
- As part of the `grill-with-docs` pre-filing check
- When the user says `/verify:plan` or asks "validate this plan"

## Inputs

- A plan.md file path (required, positional)
- `--strict` (optional flag): fail on warnings (broken but non-critical references)

## Check families

### 1. Section completeness

Required sections (case-insensitive header match):

| Section | Weight | Notes |
|---|---|---|
| Goals / Objectives | required | Must appear |
| Requirements | required | User stories or acceptance criteria |
| Success criteria | required | Binary, observable outcomes |
| Milestones / Timeline / Phases | recommended | At least one |
| Risks / Assumptions | recommended | At least one |

Report each as `{ status: "pass" | "warn" | "fail", found: boolean }`.

### 2. Reference validation

- Markdown links `[text](url)` where url looks like a file path (relative, no scheme) — verify the file exists.
- Markdown links with a scheme (http/https) — check HTTP HEAD returns ≤399. Timeout 5s.
- `[slug]()` internal xref links — skip (cross-document).
- Duplicate link targets — flag as warning (dead link in one → dead link in all).

Report each as `{ target: string, type: "file" | "url" | "broken-file" | "broken-url", status: "ok" | "broken", line: number }`.

### 3. Assumption surfacing

Pattern-match lines containing:
- `# assumption:`, `- assumption:`, `* assumption:` (explicit marker)
- Lines containing "assumption" near a requirement (- [ ] ... lines or numbered items)
- `> assumption:` blockquote variant

Each is reported as `{ text: string, line: number, confidence: "high" | "medium" }`.

### 4. Overall pass/fail

- `pass`: All required sections present AND zero broken references
- `fail`: Any required section missing OR any reference is a broken local file path
- `warn`: Warnings only (broken http links when not --strict, missing recommended sections)

## Output schema

```json
{
  "plan_path": "/path/to/plan.md",
  "overall": "pass" | "warn" | "fail",
  "sections": [
    { "name": "Goals", "status": "pass", "found": true, "line": 12 }
  ],
  "references": [
    { "target": "../README.md", "type": "file", "status": "ok", "line": 34 }
  ],
  "assumptions": [
    { "text": "assumption: users have an existing account", "line": 56, "confidence": "high" }
  ],
  "summary": { "sections_passed": 4, "sections_failed": 1, "refs_broken": 0, "assumptions_found": 2 }
}
```

## Procedure

1. Read input path.
2. Parse markdown into lines for line-number mapping.
3. Run `sectionCheck()`, `referenceCheck()`, `assumptionCheck()`.
4. Merge into final report.
5. Print the JSON report to stdout.
6. Emit a `note` event to the ledger with the report (bookie).
7. Return overall status to the caller.

## Dependencies

No external deps beyond Node.js stdlib (`node:fs`, `node:path`, `node:https` for URL checks).

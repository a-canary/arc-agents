import { test, expect } from "bun:test";
import { parseFollowupTable } from "./followup-table";

const SAMPLE = `# Analysis: foo recent sessions

## TL;DR
... bla ...

## Patterns
1. pattern one
2. pattern two

## Recommended follow-up rows to file (via bookie; out of scope for this hygiene slice)

| Priority | Title (slug) | Type | Notes | LOC |
|---|---|---|---|---|
| P1 (Critical) | \`foo-merge-pr42-do-the-thing\` | quality (or HITL if merger lacks scope) | \`gh pr merge 42 --squash\` after re-verifying diff. | \u22645 |
| P1 (Critical) | \`foo-delete-stranded-deadbeef-branch\` | quality | \`git push origin :worker/...-trash-files\`; production main is correct. | \u22645 |
| P2 (High) | \`foo-add-watchdog-v2\` | quality | sharper trigger: state=blocked AND updated_at < now-14d \u21d2 auto-pause. | \u226430 |
`;

test("parseFollowupTable: extracts rows from a real analyse-recent-sessions table", () => {
  const rows = parseFollowupTable(SAMPLE);
  expect(rows.length).toBe(3);
  expect(rows[0]!.title).toBe("foo-merge-pr42-do-the-thing");
  expect(rows[0]!.type).toBe("quality");
  expect(rows[0]!.body).toContain("gh pr merge 42 --squash");
  expect(rows[1]!.title).toBe("foo-delete-stranded-deadbeef-branch");
  expect(rows[1]!.type).toBe("quality");
  expect(rows[2]!.title).toBe("foo-add-watchdog-v2");
});

test("parseFollowupTable: prefers HITL when explicitly first-typed", () => {
  const md = `## Recommended follow-up

| P | Title | Type | Notes |
|---|---|---|---|
| P1 | \`bar-row\` | HITL (needs human) | desc |
`;
  const rows = parseFollowupTable(md);
  expect(rows.length).toBe(1);
  expect(rows[0]!.type).toBe("hitl");
  expect(rows[0]!.body.toLowerCase()).toContain("needs human");
});

test("parseFollowupTable: returns empty when no heading", () => {
  expect(parseFollowupTable("# Analysis\n\nNo table here.\n")).toEqual([]);
});

test("parseFollowupTable: returns empty when heading present but no table", () => {
  const md = `# A\n\n## Recommended follow-up rows\n\nno markdown table after this\n`;
  expect(parseFollowupTable(md)).toEqual([]);
});

test("parseFollowupTable: skips separator row and only emits data rows", () => {
  const md = `## Recommended follow-ups

| P | Title | Type | Notes |
|---|---|---|---|
| P1 | \`a-row\` | quality | desc a |
| P2 | \`b-row\` | quality | desc b |
`;
  const rows = parseFollowupTable(md);
  expect(rows.length).toBe(2);
  expect(rows.map((r) => r.title)).toEqual(["a-row", "b-row"]);
});

test("parseFollowupTable: tolerates heading variants (Recommended follow-up / follow-ups / Follow-up rows)", () => {
  for (const h of [
    "## Recommended follow-up rows",
    "## Recommended follow-ups",
    "## Recommended follow-up rows to file",
  ]) {
    const md = `${h}\n\n| T | Notes |\n|---|---|\n| \`x-row\` | quality | desc |\n`;
    expect(parseFollowupTable(md).length).toBe(1);
  }
});

test("parseFollowupTable: defaults type to quality when no known type word found", () => {
  const md = `## Recommended follow-up

| T | Notes |
|---|---|
| \`mystery-row\` | (no type word) |
`;
  const rows = parseFollowupTable(md);
  expect(rows[0]!.type).toBe("quality");
});

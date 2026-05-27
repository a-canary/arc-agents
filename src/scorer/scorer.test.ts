/**
 * scorer.test.ts — Tests for quality scorer
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  computeStructuralMetrics,
  scoreStructural,
  scoreStructuralFromText,
  scoreStructuredOutput,
} from "./scorer.js";

describe("computeStructuralMetrics", () => {
  it("counts tokens roughly (1 token per ~4 chars)", () => {
    const text = "a".repeat(400);
    const m = computeStructuralMetrics(text);
    expect(m.tokenCount).toBe(100);
  });

  it("counts headings", () => {
    const text = "# Title\n## Section\n### Subsection";
    const m = computeStructuralMetrics(text);
    expect(m.headingCount).toBe(3);
  });

  it("counts code blocks", () => {
    const text = "```\ncode here\n```\n\n```\nmore code\n```";
    const m = computeStructuralMetrics(text);
    expect(m.codeBlockCount).toBe(2);
  });

  it("detects abstract / references / conclusion", () => {
    const text = "## Abstract\n\nContent.\n\n## References\n\n1. Foo\n\n## Conclusion\n\nDone.";
    const m = computeStructuralMetrics(text);
    expect(m.hasAbstract).toBe(true);
    expect(m.hasReferences).toBe(true);
    expect(m.hasConclusion).toBe(true);
  });

  it("computes unique word ratio", () => {
    const text = "the cat sat on the mat the cat"; // "the" appears 3x, rest unique
    const m = computeStructuralMetrics(text);
    // unique words: the, cat, sat, on, mat = 5, total = 8
    expect(m.uniqueWordRatio).toBeGreaterThan(0.5);
  });
});

describe("scoreStructural", () => {
  it("returns ~5 for minimal content without bonuses", () => {
    const m = { tokenCount: 200, lineCount: 5, headingCount: 0, codeBlockCount: 0,
      listItemCount: 0, tableCount: 0, hasAbstract: false, hasReferences: false,
      hasConclusion: false, avgLineLength: 40, uniqueWordRatio: 0.5 };
    // baseline 5, no breadth, no depth, good line length +0.5 (40 in [40,120])
    // unique 0.5 not > 0.6 → no bonus, not < 0.3 → no penalty
    // token 200 not < 200 → no penalty
    expect(scoreStructural(m)).toBe(5.5);
  });

  it("adds points for breadth features", () => {
    const m = { tokenCount: 200, lineCount: 10, headingCount: 3, codeBlockCount: 2,
      listItemCount: 5, tableCount: 1, hasAbstract: false, hasReferences: false,
      hasConclusion: false, avgLineLength: 40, uniqueWordRatio: 0.7 };
    // breadth: 3 headings + 1 + 1 code + 1 lists + 1 table = 4 pts
    // baseline 5 + 4 = 9, but max is 10
    const s = scoreStructural(m);
    expect(s).toBeGreaterThanOrEqual(8);
  });

  it("adds points for depth (abstract + references)", () => {
    const m = { tokenCount: 200, lineCount: 5, headingCount: 1, codeBlockCount: 0,
      listItemCount: 0, tableCount: 0, hasAbstract: true, hasReferences: true,
      hasConclusion: false, avgLineLength: 40, uniqueWordRatio: 0.7 };
    const s = scoreStructural(m);
    expect(s).toBeGreaterThanOrEqual(7); // baseline 5 + abstract+refs 2
  });

  it("penalizes very short output", () => {
    const m = { tokenCount: 50, lineCount: 2, headingCount: 0, codeBlockCount: 0,
      listItemCount: 0, tableCount: 0, hasAbstract: false, hasReferences: false,
      hasConclusion: false, avgLineLength: 20, uniqueWordRatio: 0.8 };
    const s = scoreStructural(m);
    expect(s).toBeLessThan(5);
  });

  it("penalizes heavy repetition (low unique word ratio)", () => {
    const m = { tokenCount: 500, lineCount: 20, headingCount: 0, codeBlockCount: 0,
      listItemCount: 0, tableCount: 0, hasAbstract: false, hasReferences: false,
      hasConclusion: false, avgLineLength: 20, uniqueWordRatio: 0.15 };
    // baseline 5 + breadth 0 + depth 0 + substance 0 (avgLineLen 20 < 40) -1 (unique < 0.3) = 4
    const s = scoreStructural(m);
    expect(s).toBeLessThanOrEqual(4);
  });

  it("caps score at 10", () => {
    const m = { tokenCount: 500, lineCount: 30, headingCount: 5, codeBlockCount: 3,
      listItemCount: 10, tableCount: 2, hasAbstract: true, hasReferences: true,
      hasConclusion: true, avgLineLength: 80, uniqueWordRatio: 0.75 };
    expect(scoreStructural(m)).toBe(10);
  });
});

describe("scoreStructuralFromText", () => {
  it("scores a well-structured document", () => {
    const doc = `
## Abstract
This paper examines the properties of quality scoring.

## Introduction
Background content here with substantial prose.

## Methods
- Step one
- Step two
- Step three

## Results
| Column A | Column B |
|----------|----------|
| Data 1   | Data 2   |

\`\`\`javascript
console.log("example");
\`\`\`

## References
1. Smith et al. 2025
2. Jones et al. 2024

## Conclusion
Key findings summarized.
`.trim();
    const r = scoreStructuralFromText(doc);
    expect(r.score).toBeGreaterThanOrEqual(8);
    expect(r.method).toBe("structural");
    expect(r.blocking).toHaveLength(0);
  });

  it("returns blocking issues for score < 5", () => {
    const r = scoreStructuralFromText("Short.");
    expect(r.score).toBeLessThan(5);
    expect(r.blocking.length).toBeGreaterThan(0);
  });

  it("returns blocking for very short output", () => {
    const r = scoreStructuralFromText("Hi");
    expect(r.details.tokens).toBeLessThan(100);
    expect(r.blocking.some(b => b.includes("too short"))).toBe(true);
  });
});

describe("scoreStructuredOutput", () => {
  it("passes when all required fields present", () => {
    const data = { issues: [{ id: 1 }], summary: "Found 3 issues in total" };
    const r = scoreStructuredOutput(data, ["issues", "summary"]);
    expect(r.blocking).toHaveLength(0);
    expect(r.score).toBeGreaterThanOrEqual(6);
  });

  it("blocks when required fields missing", () => {
    const data = { issues: [] };
    const r = scoreStructuredOutput(data, ["issues", "summary", "count"]);
    expect(r.blocking.some(b => b.includes("missing"))).toBe(true);
    expect(r.details.missing).toContain("summary");
    expect(r.details.missing).toContain("count");
  });

  it("increments score for non-empty array fields", () => {
    const data = { issues: [{ id: 1 }, { id: 2 }], summary: "Two issues found" };
    const r = scoreStructuredOutput(data, ["issues", "summary"]);
    expect(r.score).toBeGreaterThan(5);
  });
});
// src/verify/design.ts — Design document validation harness.
//
// Reuses section-check logic from plan.ts with a design-specific section catalog.
// Reference integrity and assumption surfacing are reused wholesale.
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { checkReferences, surfaceAssumptions, type RefResult, type AssumptionResult, type SectionResult } from "./plan";

// ─── Design section catalog ─────────────────────────────────────────────────

const OVERVIEW_HEADERS = ["overview", "purpose", "introduction", "background", "context"];
const ARCH_HEADERS = ["architecture", "architecture overview", "design", "data model", "model", "structure", "system design"];
const API_HEADERS = ["api", "api design", "interface", "interfaces", "endpoints", "commands", "protocol"];
const EDGE_HEADERS = ["edge cases", "edge cases and error handling", "error handling", "failures", "edge-case handling"];
const OQ_HEADERS = ["open questions", "open questions and tradeoffs", "open questions", "questions", "trade-offs", "tradeoffs"];

function classifyDesignLine(line: string): string | null {
  // Guard: only inspect lines that look like Markdown ATX headings.
  if (!/^#{1,6}\s/.test(line)) return null;
  const lower = line.toLowerCase().replace(/^#+\s*/, "");
  if (ARCH_HEADERS.some((h) => lower.includes(h))) return "Architecture";
  if (API_HEADERS.some((h) => lower.includes(h))) return "API/Interface";
  if (EDGE_HEADERS.some((h) => lower.includes(h))) return "Edge Cases";
  if (OQ_HEADERS.some((h) => lower.includes(h))) return "Open Questions";
  if (OVERVIEW_HEADERS.some((h) => lower.includes(h))) return "Overview";
  return null;
}

export function checkDesignSections(markdown: string): SectionResult[] {
  const results: SectionResult[] = [
    { name: "Overview", status: "fail", found: false, line: 0 },
    { name: "Architecture", status: "fail", found: false, line: 0 },
    { name: "API/Interface", status: "fail", found: false, line: 0 },
    { name: "Edge Cases", status: "warn", found: false, line: 0 },
    { name: "Open Questions", status: "warn", found: false, line: 0 },
  ];

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = classifyDesignLine(line);
    if (match) {
      const result = results.find((r) => r.name === match);
      if (result && !result.found) {
        result.found = true;
        result.status = "pass";
        result.line = i + 1;
      }
    }
  }

  return results;
}

// ─── Top-level report ────────────────────────────────────────────────────────

export type DesignValidationReport = {
  design_path: string;
  overall: "pass" | "warn" | "fail";
  sections: SectionResult[];
  references: RefResult[];
  assumptions: AssumptionResult[];
  summary: {
    sections_passed: number;
    sections_failed: number;
    sections_warned: number;
    refs_broken: number;
    assumptions_found: number;
  };
};

export async function validateDesign(
  designPath: string,
  opts: { strict?: boolean } = {},
): Promise<DesignValidationReport> {
  let content: string;
  try {
    content = readFileSync(designPath, "utf8");
  } catch {
    throw new Error(`Cannot read design doc at ${designPath}`);
  }

  const baseDir = dirname(resolve(designPath));
  const sections = checkDesignSections(content);
  const refs = checkReferences(content, baseDir);
  const assumptions = surfaceAssumptions(content);

  const secsPassed = sections.filter((s) => s.found).length;
  const secsFailed = sections.filter((s) => s.status === "fail" && !s.found).length;
  const secsWarned = sections.filter((s) => s.status === "warn" && !s.found).length;
  const refsBroken = refs.filter((r) => r.status === "broken").length;

  let overall: "pass" | "warn" | "fail" = "pass";
  if (secsFailed > 0 || refsBroken > 0) {
    overall = "fail";
  } else if (opts.strict && secsWarned > 0) {
    overall = "fail";
  } else if (secsWarned > 0) {
    overall = "warn";
  }

  return {
    design_path: designPath,
    overall,
    sections,
    references: refs,
    assumptions,
    summary: {
      sections_passed: secsPassed,
      sections_failed: secsFailed,
      sections_warned: secsWarned,
      refs_broken: refsBroken,
      assumptions_found: assumptions.length,
    },
  };
}

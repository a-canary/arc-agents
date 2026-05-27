// src/verify/plan.ts — Plan validation harness.
//
// Provides sectionCompleteness(), referenceIntegrity(), and assumptionSurfacing()
// for plan.md validation. Returns structured reports consumed by the skill.
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute, join, extname } from "node:path";
import https from "node:https";

// ─── Section completeness ────────────────────────────────────────────────────

export interface SectionResult {
  name: string;
  status: "pass" | "warn" | "fail";
  found: boolean;
  line: number;
}

const GOALS_HEADERS = ["goals", "objectives", "goal", "objective"];
const REQ_HEADERS = ["requirements", "requirement", "needs", "specification"];
const SUCCESS_HEADERS = ["success criteria", "success-criteria", "definition of done", "acceptance criteria", "done criteria"];
const MILESTONE_HEADERS = ["milestones", "milestone", "timeline", "phases", "phase", "roadmap", "schedule", "交付物", "deliverables"];
const RISK_HEADERS = ["risks", "assumptions and risks", "assumptions", "risk", "constraints and risks", "concerns"];

function headerMatches(line: string, headers: string[]): boolean {
  const lower = line.toLowerCase().replace(/^#+\s*/, "");
  return headers.some((h) => lower.includes(h));
}

function classifyLine(line: string): string | null {
  // Returns a canonical section name for "# ..." lines.
  if (headerMatches(line, GOALS_HEADERS)) return "Goals";
  if (headerMatches(line, REQ_HEADERS)) return "Requirements";
  if (headerMatches(line, SUCCESS_HEADERS)) return "Success Criteria";
  if (headerMatches(line, MILESTONE_HEADERS)) return "Milestones";
  if (headerMatches(line, RISK_HEADERS)) return "Risks/Assumptions";
  return null;
}

export interface SectionCheckOptions {
  includeRecommended?: boolean;
}

export function checkSections(markdown: string): SectionResult[] {
  // Required sections must appear. Recommended sections get warn status if absent.
  const results: SectionResult[] = [
    { name: "Goals", status: "fail", found: false, line: 0 },
    { name: "Requirements", status: "fail", found: false, line: 0 },
    { name: "Success Criteria", status: "fail", found: false, line: 0 },
    { name: "Milestones", status: "warn", found: false, line: 0 },
    { name: "Risks/Assumptions", status: "warn", found: false, line: 0 },
  ];

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = classifyLine(line);
    if (match) {
      const result = results.find((r) => r.name === match);
      if (result && !result.found) {
        result.found = true;
        result.status = result.status === "fail" ? "pass" : "pass";
        result.line = i + 1;
      }
    }
  }

  return results;
}

// ─── Reference integrity ─────────────────────────────────────────────────────

export interface RefResult {
  target: string;
  type: "file" | "url" | "broken-file" | "broken-url" | "unknown";
  status: "ok" | "broken";
  line: number;
}

// Matches [text](url) markdown links where url is not an internal xref.
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const HTTP_SCHEME_RE = /^https?:\/\//;

// Matches [slug]() or [text](#anchor) style internal cross-references.
function isInternalRef(url: string): boolean {
  return url.startsWith("#") || (url.startsWith("[") && !url.includes("://"));
}

// Checks one URL via HTTP HEAD. Returns true if ≤399.
function checkHttpUrl(url: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = https.request(url, { method: "HEAD", timeout: timeoutMs }, (res) => {
        resolve(res.statusCode !== undefined && res.statusCode < 400);
        req.destroy();
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => {
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

export function checkReferences(markdown: string, baseDir: string): RefResult[] {
  const results: RefResult[] = [];
  const lines = markdown.split("\n");
  const seenTargets = new Map<string, number>(); // target for duplicate detection

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let match: RegExpExecArray | null;
    MD_LINK_RE.lastIndex = 0;
    while ((match = MD_LINK_RE.exec(line)) !== null) {
      const url = match[2];
      if (!url) continue;
      if (isInternalRef(url)) continue;

      const lineNum = i + 1;

      if (HTTP_SCHEME_RE.test(url)) {
        results.push({
          target: url,
          type: "url",
          status: "ok",
          line: lineNum,
        });
      } else if (!url.includes("://")) {
        // Relative file path — resolve against plan.md's directory.
        const resolved = isAbsolute(url) ? url : join(baseDir, url);
        const exists = existsSync(resolved) && statSync(resolved).isFile();
        results.push({
          target: url,
          type: exists ? "file" : "broken-file",
          status: exists ? "ok" : "broken",
          line: lineNum,
        });
      } else {
        results.push({
          target: url,
          type: "unknown",
          status: "ok",
          line: lineNum,
        });
      }

      // Track duplicates across lines.
      if (seenTargets.has(url)) {
        // Overwrite status to "broken" if this is a duplicate of a broken ref.
        const priorLine = seenTargets.get(url)!;
        const priorResult = results.find((r) => r.line === priorLine && r.target === url);
        if (priorResult && priorResult.status === "broken") {
          const dup = results[results.length - 1]!;
          dup.status = "broken";
          dup.type = "broken-file";
        }
      }
      seenTargets.set(url, lineNum);
    }
  }

  return results;
}

// ─── Assumption surfacing ────────────────────────────────────────────────────

export interface AssumptionResult {
  text: string;
  line: number;
  confidence: "high" | "medium";
}

// Explicit assumption markers (high confidence).
const ASSUMPTION_EXPLICIT_RE = /^(\s*[-*+>]\s*|\s*#+\s*)(assumption):/i;

// Lines that are near checklist items or numbered lists suggesting implied
// assumptions (medium confidence).
const CHECK_RE = /^\s*[-*]\s*\[[\sx]\]/;
const NUMBER_RE = /^\s*\d+[.)]\s+/;
const ASSUMPTION_CONTEXT_RE = /assumption|presume|expect|stub|hypothesis|assume/gi;

export function surfaceAssumptions(markdown: string): AssumptionResult[] {
  const results: AssumptionResult[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // High-confidence: explicit markers.
    const explicitMatch = ASSUMPTION_EXPLICIT_RE.exec(line);
    if (explicitMatch) {
      results.push({
        text: line.trim(),
        line: i + 1,
        confidence: "high",
      });
      continue;
    }

    // Medium-confidence: near-checklist lines with "assumption" context.
    const nearCheck = CHECK_RE.test(line) || NUMBER_RE.test(line);
    const hasAssumptionKeyword = ASSUMPTION_CONTEXT_RE.test(line);
    if (nearCheck && hasAssumptionKeyword) {
      results.push({
        text: line.trim(),
        line: i + 1,
        confidence: "medium",
      });
    }
  }

  return results;
}

// ─── Top-level report ────────────────────────────────────────────────────────

export type OverallStatus = "pass" | "warn" | "fail";

export interface PlanValidationReport {
  plan_path: string;
  overall: OverallStatus;
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
}

export interface ValidationOptions {
  strict?: boolean;
}

export async function validatePlan(
  planPath: string,
  opts: ValidationOptions = {},
): Promise<PlanValidationReport> {
  let content: string;
  try {
    content = readFileSync(planPath, "utf8");
  } catch {
    throw new Error(`Cannot read plan.md at ${planPath}`);
  }

  const baseDir = dirname(resolve(planPath));
  const sections = checkSections(content);

  // Check HTTP URLs concurrently, but NOT in the sync path.
  // We still build the file-reference results synchronously.
  const refs = checkReferences(content, baseDir);

  // Async HTTP check — fire off all HTTP refs and wait.
  const httpRefs = refs.filter((r) => r.type === "url" || r.type === "broken-url");
  const httpResults = await Promise.all(
    httpRefs.map(async (r) => {
      if (r.type === "url") {
        const ok = await checkHttpUrl(r.target);
        return { idx: refs.indexOf(r), ok, resolvedOk: ok ? false : r.status === "ok" ? "ok" : "broken" };
      }
      return { idx: refs.indexOf(r), ok: false, resolvedOk: r.status };
    }),
  );

  // Build summary counts (use current results for now; async is parallel).
  const secsPassed = sections.filter((s) => s.found).length;
  const secsFailed = sections.filter((s) => s.status === "fail" && !s.found).length;
  const secsWarned = sections.filter((s) => s.status === "warn" && !s.found).length;
  const refsBroken = refs.filter((r) => r.status === "broken").length;
  const assumptionsFound = surfaceAssumptions(content).length;

  // Determine overall status.
  let overall: OverallStatus = "pass";
  if (secsFailed > 0 || refsBroken > 0) {
    overall = "fail";
  } else if (opts.strict && secsWarned > 0) {
    overall = "fail";
  } else if (secsWarned > 0) {
    overall = "warn";
  }

  return {
    plan_path: planPath,
    overall,
    sections,
    references: refs,
    assumptions: surfaceAssumptions(content),
    summary: {
      sections_passed: secsPassed,
      sections_failed: secsFailed,
      sections_warned: secsWarned,
      refs_broken: refsBroken,
      assumptions_found: assumptionsFound,
    },
  };
}

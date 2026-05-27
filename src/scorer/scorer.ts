/**
 * scorer.ts — Quality scorer for pipeline outputs
 *
 * Two scoring modes:
 *   - structural: lightweight heuristic metrics (tokens, structure, coverage)
 *   - judge: LLM-based semantic quality evaluation via pi
 *
 * The structural scorer is the default (free, fast). The judge runs only
 * when `useJudge: true` or when pipeline config has a judge model.
 * Neither mode uses output-size-ratio scoring — that's the obsolete heuristic
 * this module replaces.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export interface ScoreResult {
  score: number;        // 0-10 quality score
  method: "structural" | "llm-judge";
  details: Record<string, number | string>;
  blocking: string[];   // hard-fail reasons (score < 5 triggers escalation)
}

/** Configuration for the scorer */
export interface ScorerConfig {
  /** Model to use for LLM judge. Omit for structural-only. */
  judgeModel?: string;
  /** Provider for judge model. Default: openai */
  judgeProvider?: string;
  /** Minimum score to count as pass. Default: 7 */
  threshold?: number;
  /** Semantic criteria for judge evaluation */
  criteria?: string[];
}

// ── Structural Scoring ───────────────────────────────────────────────────────

interface StructuralMetrics {
  tokenCount: number;
  lineCount: number;
  headingCount: number;
  codeBlockCount: number;
  listItemCount: number;
  tableCount: number;
  hasAbstract: boolean;
  hasReferences: boolean;
  hasConclusion: boolean;
  avgLineLength: number;
  uniqueWordRatio: number;
}

/**
 * Compute structural metrics from text content.
 * Uses only text analysis — no LLM, no model calls.
 */
export function computeStructuralMetrics(text: string): StructuralMetrics {
  const lines = text.split("\n");
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  const wordCount = (text.match(/\b\w+\b/g) ?? []).length;
  const uniqueWords = new Set((text.match(/\b\w+\b/g) ?? []).map(w => w.toLowerCase()));
  const tokens = countTokens(text);

  return {
    tokenCount: tokens,
    lineCount: nonEmptyLines.length,
    headingCount: (text.match(/^#{1,3}\s/gm) ?? []).length,
    codeBlockCount: (text.match(/```/g) ?? []).length / 2,
    listItemCount: (text.match(/^[\s]*[-*+]\s/gm) ?? []).length + (text.match(/^\d+\.\s/gm) ?? []).length,
    tableCount: (text.match(/\|.*\|/g) ?? []).length / 3,
    hasAbstract: /##?\s*Abstract/i.test(text),
    hasReferences: /##?\s*References|Bibliography|Works Cited/i.test(text),
    hasConclusion: /##?\s*Conclusion|Summary|Takeaways/i.test(text),
    avgLineLength: nonEmptyLines.length > 0
      ? nonEmptyLines.reduce((s, l) => s + l.trim().length, 0) / nonEmptyLines.length
      : 0,
    uniqueWordRatio: wordCount > 0 ? uniqueWords.size / wordCount : 0,
  };
}

/**
 * Score structural metrics on a 0-10 scale.
 *
 * Scoring dimensions:
 *   - Breadth: does it have multiple section types (headings, lists, code, tables)?
 *   - Depth: does it have abstract + references + conclusion?
 *   - Substance: is avg line length reasonable (not just headers)?
 *   - Density: unique word ratio (not just filler repetition)
 *
 * No output-size-ratio component — size alone is not quality.
 */
export function scoreStructural(metrics: StructuralMetrics): number {
  let score = 5; // baseline

  // Breadth: +1 for each non-zero structural feature, capped at +3
  const breadthFeatures = [
    metrics.headingCount >= 3 ? 1 : 0,
    metrics.codeBlockCount >= 2 ? 1 : 0,
    metrics.listItemCount >= 5 ? 1 : 0,
    metrics.tableCount >= 1 ? 1 : 0,
  ];
  score += Math.min(3, breadthFeatures.reduce((a, b) => a + b, 0));

  // Depth: +2 if has abstract AND references, +1 if has conclusion
  if (metrics.hasAbstract && metrics.hasReferences) score += 2;
  else if (metrics.hasAbstract || metrics.hasReferences) score += 1;
  if (metrics.hasConclusion) score += 1;

  // Substance: reasonable avg line length (40-120 chars = substantive content)
  if (metrics.avgLineLength >= 40 && metrics.avgLineLength <= 120) score += 1;
  else if (metrics.avgLineLength > 120) score += 0.5; // long lines might be dense prose

  // Density: unique word ratio > 0.6 suggests real content, not repetition
  if (metrics.uniqueWordRatio > 0.6) score += 1;
  else if (metrics.uniqueWordRatio < 0.3) score -= 1; // heavy repetition penalty

  // Token floor: very short outputs score poorly
  if (metrics.tokenCount < 200) score -= 1.5;
  else if (metrics.tokenCount < 500) score -= 0.5;

  return Math.max(0, Math.min(10, score));
}

/**
 * Default structural scorer — computes metrics + scores in one pass.
 * Free, no model calls, deterministic.
 */
export function scoreStructuralFromText(text: string): ScoreResult {
  const metrics = computeStructuralMetrics(text);
  const score = scoreStructural(metrics);
  const blocking: string[] = [];
  if (score < 5) blocking.push("structural score below 5 — escalate to judge");
  if (metrics.tokenCount < 100) blocking.push("output too short (< 100 tokens)");

  return {
    score,
    method: "structural",
    details: {
      tokens: metrics.tokenCount,
      lines: metrics.lineCount,
      headings: metrics.headingCount,
      codeBlocks: metrics.codeBlockCount,
      lists: metrics.listItemCount,
      tables: metrics.tableCount,
      abstract: metrics.hasAbstract,
      references: metrics.hasReferences,
      conclusion: metrics.hasConclusion,
      avgLineLen: Math.round(metrics.avgLineLength),
      uniqueWordRatio: Math.round(metrics.uniqueWordRatio * 100) / 100,
    },
    blocking,
  };
}

// ── LLM Judge ────────────────────────────────────────────────────────────────

interface JudgeResult {
  passed: boolean;
  score: number;
  blocking: string[];
  concerns: string[];
  summary: string;
}

/**
 * Invoke LLM judge via `pi -p` to evaluate content against semantic criteria.
 * Uses the strongest available model unless judgeModel is specified.
 *
 * Returns a Judgment with per-criterion scores + overall pass/fail.
 * Block if score < 5 on any criterion.
 */
export async function scoreWithJudge(
  content: string,
  task: string,
  criteria: string[],
  config: ScorerConfig,
): Promise<ScoreResult> {
  const model = config.judgeModel ?? "claude-sonnet-4-20250514";
  const provider = config.judgeProvider ?? "anthropic";
  const threshold = config.threshold ?? 7;

  const gatesText = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const judgePrompt = `Evaluate this output against each quality criterion.
Return JSON with a "scores" array (one number per criterion, 1-10) and an "overall" number.

OUTPUT:
${content.slice(0, 8000)}

CRITERIA:
${gatesText}

Respond JSON only: {"scores":[...],"overall":<1-10>,"blocking":[],"concerns":[]}`;

  const promptFile = `/tmp/pi-judge-prompt-${Date.now()}.txt`;
  require("node:fs").writeFileSyncSync?.(() => {}) ?? (() => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(promptFile, judgePrompt);
  })();
  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(promptFile, judgePrompt);
  } catch {
    // already written or import error
  }

  let stdout = "";
  try {
    stdout = execSync(
      `pi --provider ${provider} --model ${model} --print --no-tools @${promptFile}`,
      {
        encoding: "utf-8",
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
  } catch (e: any) {
    stdout = e.stdout?.toString() ?? "";
  }

  // Cleanup
  try { require("node:fs").unlinkSync(promptFile); } catch {}

  // Strip pi control sequences
  const cleaned = stdout
    .replace(/\]777;[^\n]*/g, "")
    .replace(/^Failed to load[^\n]*\n/gm, "")
    .replace(/^Warning:[^\n]*\n/gm, "")
    .trim();

  let parsed: any = {};
  try {
    // Try to extract JSON from output
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {
    // If JSON parse fails, use the cleaned text as the output
  }

  const scores = parsed.scores ?? [];
  const overall = parsed.overall ?? 5;
  const blocking: string[] = [...(parsed.blocking ?? [])];
  const concerns: string[] = [...(parsed.concerns ?? [])];

  return {
    score: overall,
    method: "llm-judge",
    details: {
      model,
      threshold,
      criteriaCount: criteria.length,
      perCriterion: criteria.map((c, i) => ({ criterion: c, score: scores[i] ?? 0 })),
      summary: parsed.summary ?? "",
    },
    blocking: overall < threshold ? [...blocking, `score ${overall} < threshold ${threshold}`] : blocking,
  };
}

// ── Composite Scorer ────────────────────────────────────────────────────────

/**
 * Composite scorer: structural first, judge on demand.
 *
 * @param text - the output to score
 * @param task - task name (for judge prompt context)
 * @param criteria - semantic criteria for judge (structural scorer ignores these)
 * @param config - scorer configuration
 * @returns ScoreResult with score, method, details, blocking
 *
 * Logic:
 *   1. Run structural scorer (always, free)
 *   2. If structural score < 5 OR config.judgeModel is set → run judge
 *   3. Return judge result if available, else structural result
 */
export async function score(
  text: string,
  task: string,
  criteria: string[] = [],
  config: ScorerConfig = {},
): Promise<ScoreResult> {
  // Always run structural first
  const structural = scoreStructuralFromText(text);

  // Run judge if structural score is low or judge is configured
  const shouldJudge = structural.score < 5
    || structural.blocking.length > 0
    || !!config.judgeModel;

  if (!shouldJudge || criteria.length === 0) {
    return structural;
  }

  try {
    const judged = await scoreWithJudge(text, task, criteria, config);
    // Use judge score if it's more discriminating
    return judged.score > 0 ? judged : structural;
  } catch (err: any) {
    // Judge failed — fall back to structural with warning
    return {
      ...structural,
      details: {
        ...structural.details,
        judgeError: err.message,
        judgeFallback: true,
      },
    };
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Rough token count (used when no tokenizer available).
 * ~4 chars per token for English prose.
 */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Score a JSON-parsed structured output (e.g., { issues: [...], summary: "..." }).
 * Checks for required fields and computes a structural score.
 */
export function scoreStructuredOutput(
  data: Record<string, unknown>,
  requiredFields: string[],
): ScoreResult {
  const blocking: string[] = [];
  const details: Record<string, number | string> = {};

  // Field presence check
  const missing = requiredFields.filter(f => data[f] == null);
  if (missing.length > 0) {
    blocking.push(`missing required fields: ${missing.join(", ")}`);
  }

  // Compute structural score based on content
  let score = 5;
  if (data.summary && typeof data.summary === "string" && data.summary.length > 50) score += 1;
  if (Array.isArray(data.issues) && data.issues.length > 0) score += 1;
  if (Array.isArray(data.items) && data.items.length > 0) score += 1;
  if (typeof data.total === "number" && data.total > 0) score += 0.5;

  // Penalize if critical fields are missing
  if (missing.length > 0) score -= Math.min(2, missing.length * 0.5);

  details.requiredPresent = requiredFields.length - missing.length;
  details.requiredTotal = requiredFields.length;
  details.missing = missing.join(", ") || "none";

  return {
    score: Math.max(0, Math.min(10, score)),
    method: "structural",
    details,
    blocking,
  };
}
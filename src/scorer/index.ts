/**
 * scorer/index.ts — Quality scorer module barrel
 */
export {
  type ScorerConfig,
  type ScoreResult,
  type StructuralMetrics,
  computeStructuralMetrics,
  scoreStructural,
  scoreStructuralFromText,
  scoreStructuredOutput,
  scoreWithJudge,
  score,
} from "./scorer.js";
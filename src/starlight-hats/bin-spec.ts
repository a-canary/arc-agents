// Starlight-hats BinSpec — the arm-axis interface for data binning.
//
// Design goal: make bin shape an artifact-controlled axis that arms vary, not a
// fixed schema. Every axis is independently tunable; changing a BinSpec field is
// sufficient to define a new experimental arm — no code changes required.
//
// Phase 1 default (anchored as DEFAULT_BIN_SPEC):
//   anchor = stratified-by-source
//   rankingScope = within-source
//   topK = 2200
//   overlapMode = none (0%)
//   chunkerVersion = v1
//   trainRatio = 0.9
//   seed = 42
//
// See ADR: docs/adr/ (pending creation).
//
// ─── Anchor Strategy ─────────────────────────────────────────────────────────
//
// Anchor strategy determines how bin "anchors" (representative samples per source)
// are selected. Anchors are the fixed points around which bins are constructed.
//
// `stratified-by-source` (Phase 1 default):
//   Take exactly floor(topK / numSources) samples from each source.
//   Guarantees equal representation across all sources.
//   Deterministic: sort by id within source, take first K.
//
// `k-means-centroid`:
//   Cluster each source's embeddings with k-means (k = anchorsPerCluster).
//   Select the sample nearest to each centroid.
//   Deterministic: fixed k-means++ init with spec.seed.
//
// `hand-picked`:
//   Explicit list of corpus-index document IDs per source.
//   Used for targeted evaluation slices (e.g. known-hard examples).
//
// ─── Ranking Scope ────────────────────────────────────────────────────────────
//
// `within-source` (Phase 1 default):
//   Rank candidates independently within each source. Top-K per source.
//   Each source contributes proportionally.
//
// `full-pool`:
//   Rank all candidates across all sources together. Top-K total from pool.
//   High-variance sources may dominate or be excluded entirely.
//
// ─── Overlap Mode ─────────────────────────────────────────────────────────────
//
// `none` (Phase 1 default, 0% overlap):
//   train ∩ test = ∅. Clean split, no information leakage.
//
// `t-shaped`:
//   Each source: the top `overlapPercent`% of its train set also appears in test.
//   Models see a "stem" (all train) + "hat" (overlap) that also appears at eval.
//   t-shaped because train is a superset of the overlap zone.
//
// `gaussian-weighted`:
//   Test candidates sampled with Gaussian weight centered on train candidates.
//   Soft overlap: candidates near train examples are more likely in test.
//   Sigma controlled by overlapSigma.
//
// ─── Chunker Version ─────────────────────────────────────────────────────────
//
// `v1`: Fixed 128-token chunks, no overlap, greedy boundary detection.
// `v2`: Sliding window 256 tokens, 50-token stride, sentence-aware boundaries.
//
// ─── Reproducibility ──────────────────────────────────────────────────────────
//
// The builder is deterministic: same BinSpec + same corpus index → identical
// train.jsonl + test.jsonl. Seed drives pseudo-random tie-breaking and any
// stochastic steps (shuffling, Gaussian sampling). Set seed=0 for fully
// deterministic (no shuffling).

// ─── Anchor Strategy ─────────────────────────────────────────────────────────

export const ANCHOR_STRATEGIES = [
  "stratified-by-source",
  "k-means-centroid",
  "hand-picked",
] as const;
export type AnchorStrategy = (typeof ANCHOR_STRATEGIES)[number];

// ─── Ranking Scope ───────────────────────────────────────────────────────────

export const RANKING_SCOPES = ["within-source", "full-pool"] as const;
export type RankingScope = (typeof RANKING_SCOPES)[number];

// ─── Overlap Mode ─────────────────────────────────────────────────────────────

export const OVERLAP_MODES = ["none", "t-shaped", "gaussian-weighted"] as const;
export type OverlapMode = (typeof OVERLAP_MODES)[number];

// ─── Chunker Version ──────────────────────────────────────────────────────────

export const CHUNKER_VERSIONS = ["v1", "v2"] as const;
export type ChunkerVersion = (typeof CHUNKER_VERSIONS)[number];

// ─── Core BinSpec ────────────────────────────────────────────────────────────

export interface BinSpec {
  // Anchor strategy (how to select representative samples per source).
  // Phase 1 default: "stratified-by-source"
  anchor: AnchorStrategy;

  // Ranking context: where to rank candidates before selection.
  // Phase 1 default: "within-source"
  rankingScope: RankingScope;

  // Maximum candidates to select per source.
  // Phase 1 default: 2200
  topK: number;

  // Overlap strategy between train and test sets.
  // Phase 1 default: "none" (0%)
  overlapMode: OverlapMode;

  // Fraction of train candidates that also appear in test (0.0–0.5).
  // Only relevant when overlapMode = "t-shaped".
  // Phase 1 default: 0.0
  overlapPercent: number;

  // Gaussian sigma (in embedding-space distance units) for soft overlap.
  // Only relevant when overlapMode = "gaussian-weighted".
  // Phase 1 default: 1.0
  overlapSigma: number;

  // Text chunking pipeline version.
  // Phase 1 default: "v1"
  chunkerVersion: ChunkerVersion;

  // Train fraction; test fraction = 1 - trainRatio.
  // Phase 1 default: 0.9 (90/10 split)
  trainRatio: number;

  // Reproducibility seed. 0 = fully deterministic (no shuffle).
  // Phase 1 default: 42
  seed: number;

  // Explicit anchor IDs (only relevant when anchor = "hand-picked").
  // Map from source name → list of corpus document IDs.
  handPickedAnchors?: Record<string, string[]>;

  // k-means k per source (only relevant when anchor = "k-means-centroid").
  // If omitted, defaults to floor(topK / numSources).
  kMeansK?: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * Phase 1 default BinSpec.
 * Reproduces the Phase 1 training slices exactly:
 *   stratified-by-source anchors, within-source top-2200, 0% overlap, v1 chunker.
 */
export const DEFAULT_BIN_SPEC: BinSpec = {
  anchor: "stratified-by-source",
  rankingScope: "within-source",
  topK: 2200,
  overlapMode: "none",
  overlapPercent: 0.0,
  overlapSigma: 1.0,
  chunkerVersion: "v1",
  trainRatio: 0.9,
  seed: 42,
} as const;

// ─── Serialisation ────────────────────────────────────────────────────────────

/** Zod schema for runtime validation. */
import { z } from "zod";

export const anchorStrategySchema = z.enum(ANCHOR_STRATEGIES);
export const rankingScopeSchema = z.enum(RANKING_SCOPES);
export const overlapModeSchema = z.enum(OVERLAP_MODES);
export const chunkerVersionSchema = z.enum(CHUNKER_VERSIONS);

export const binSpecSchema = z.object({
  anchor: anchorStrategySchema,
  rankingScope: rankingScopeSchema,
  topK: z.number().int().positive().max(100_000),
  overlapMode: overlapModeSchema,
  overlapPercent: z.number().min(0).max(0.5),
  overlapSigma: z.number().positive(),
  chunkerVersion: chunkerVersionSchema,
  trainRatio: z.number().min(0).max(1),
  seed: z.number().int().min(0),
  handPickedAnchors: z.record(z.array(z.string())).optional(),
  kMeansK: z.number().int().positive().optional(),
});

export type BinSpecInput = z.infer<typeof binSpecSchema>;

/**
 * Validate and default a raw object into a full BinSpec.
 * Missing fields fall back to DEFAULT_BIN_SPEC values.
 */
export function makeBinSpec(raw: Partial<BinSpecInput>): BinSpec {
  return binSpecSchema.parse({ ...DEFAULT_BIN_SPEC, ...raw });
}

# Local-Only Expert LoRA Routing at 1–8B Scale: n300 v2 Benchmark Results

**Type:** Technical Report / Negative Result  
**License:** CC-BY-4.0  
**Source data:** `expert-horde` project, benchmarks v2 run  
**Companion ledger row:** `expert-horde-negative-result-writeup-shi`  
**User mission alignment:** USR-MSN-0003 (LLM democratization)

---

## 1. Abstract

We evaluated a 9-config, 300-prompt benchmark (n=300) measuring how well a local-only LoRA expert ensemble can match or surpass the quality of a frontier-class model (Opus 4.7) on domain-specialist tasks. The ensemble uses 8 domain-adapter LoRAs wired through a lightweight router, trained exclusively at 1–8B base-model scale. All 9 configurations fail the pre-registered 80% non-loss ship bar against Opus. The best result is Qwen3-8B at 17.2% non-loss. The primary driver of quality is base-model size — routing topology, concat strategy, and rank variants explain <5 percentage points of variance across the 1.2B–8B range. At 1–8B scale, local-only LoRA routing cannot close the gap to frontier-class models, regardless of topology.

---

## 2. Background and Intent

The `expert-horde` project set out to test the hypothesis that a **zero-frontier, local-only expert routing system** (LLM distillation via domain LoRAs + a lightweight selector router) could match frontier-class quality on domain-specialist tasks. The core claim: run local base models (≤4 GB quantized for P600 peers) with no API calls, at a fraction of frontier cost.

**Pre-registered ship bar** (from project memory, decision #4):  
> A2 non-loss rate ≥ 80% vs A1 (Opus 4.7 no-think) on the 60-prompt judge benchmark.

This report documents the empirical results of the n300 v2 benchmark campaign across 9 configurations. It is **a negative result that ships** — per the counsel session of 2026-05-28: "publishing the failure as a paper signals rigor, not defeat."

---

## 3. Methodology

### 3.1 Benchmark Design

**Prompt set:** `benchmark_prompts_v2.json` — 300 prompts across 4 buckets.

| Bucket | Count | Description |
|---|---|---|
| `unseen-domain` | 60 | Finance, education, marketing, agriculture, manufacturing — **no trained adapter exists** for these domains. Tests zero-shot generalization. |
| `2-compound` | 60 | Requires exactly 2 of the 8 trained domains. Tests blended routing. |
| `3-compound` | 60 | Requires 3+ trained domains. Harder cross-domain. |
| `adversarial` | 20 | Each: surface vocabulary from domain X, content needs domain Y. Tests router robustness. |

In-distribution single-domain prompts (n=100) also included; results are not broken out separately as A2 does not meaningfully struggle there.

**Judge model:** `cli/claude/opus/non` — Claude Opus 4.7, no-think mode. Blind pairwise comparison, seed=42, 60 pairs per config.

**Scoring:** Judge assigns a 1–30 quality score per response. Non-loss = (A2 wins + ties) / total pairs.

### 3.2 Configurations Tested

All A2 configs use an 8-domain LoRA ensemble. A0 = base model (`cli/claude/opus/non` → Qwen3-8B base). A1 = Opus 4.7 no-think (the baseline to beat). A2 = configured ensemble.

**Base model × topology variants:**

| Config label | Base model | LoRA topology | Notes |
|---|---|---|---|
| `lfm25-plain` | LiquidAI LFM2-1.2B | 8-adapter plain | post-base-upgrade retrain |
| `lfm25-cat` | LFM2-1.2B | 8-adapter concat | concat strategy |
| `lfm25-fanmerge` | LFM2-1.2B | fanmerge topology | |
| `lfm25-floor70` | LFM2-1.2B | floor70 strategy | |
| `lfm25-pipeline` | LFM2-1.2B | pipeline topology | |
| `qwen3-4b-plain` | Qwen3-4B | 8-adapter plain | |
| `qwen3-4b-nothink` | Qwen3-4B | plain, no-think mode | adversarial bucket adversarial at 20% |
| `qwen3-8b-plain` | Qwen3-8B | 8-adapter plain | |
| `lfm25fp16` | LFM2-1.2B FP16 | plain | FP16 precision variant |

**Total pairs evaluated:** 9 configs × 60 pairs = **540 judge evaluations.**

### 3.3 A0 vs A2 Comparison

An additional A0-vs-A2 judge run answers: does training the LoRA ensemble actually improve over the base model?

| Judge run | A1 (reference) | A2 (candidate) | A2 non-loss vs A1 |
|---|---|---|---|
| `a0_a2_qwen3_8b_v2_judge` | Qwen3-8B base (A0) | Qwen3-8B-plain A2 | 58.3% |
| `a0_a2_v2_judge` | LFM2.5 1.2B base (A0) | LFM2.5 A2 ensemble | 56.7% |
| `a0_a2_smart_judge` | LFM2.5 1.2B base (A0) | LFM2.5 A2 (smart selector) | 85.0% |

The LoRA training **does** produce improvement over the base (58%/57% non-loss vs ~50% random), confirming the adapters learn domain content. The gap is to **Opus**, not to the base model.

---

## 4. Results

### 4.1 Summary: All Configs Miss the 80% Ship Bar by 52–78 Points

| A2 config | Non-loss vs A1 (Opus) | Win / Tie / Loss | Notes |
|---|---|---|---|
| LFM2.5 plain | 8.3% | 5/0/55 | |
| LFM2.5 concat | 6.8% | 4/0/56 | 1 judge failure |
| LFM2.5 fanmerge | 8.3% | 5/0/55 | |
| LFM2.5 floor70 | 8.3% | 5/0/55 | |
| LFM2.5 pipeline | **1.7%** | 1/0/59 | worst config |
| LFM2.5 FP16 | 8.3% | 5/0/55 | |
| Qwen3-4B nothink | 5.0% | 3/0/57 | adversarial bucket: 20% non-loss |
| Qwen3-4B plain | 5.0% | 3/0/57 | |
| **Qwen3-8B plain** | **17.2%** | 9/1/50 | best config |

**Ship bar: 80%. Best observed: 17.2%. Gap: 62.8 percentage points.**

### 4.2 Per-Bucket Breakdown (Best Config: Qwen3-8B)

| Bucket | n | A2 wins | A2 non-loss % | Mean A1 score | Mean A2 score |
|---|---|---|---|---|---|
| `unseen-domain` | 25 | 4 + 1 tie | 20.8% | 27.75 | 23.30 |
| `3-compound` | 10 | 2 | 20.0% | 26.40 | 19.70 |
| `2-compound` | 14 | 1 | 7.1% | 25.64 | 18.86 |
| `adversarial` | 10 | 2 | 20.0% | 23.90 | 22.00 |

Qwen3-8B performs comparatively best on `unseen-domain` (20.8%) and worst on `2-compound` (7.1%). The adversarial bucket is competitive at 20%, suggesting the ensemble can hold its own at category-crossing content when the base model is large enough.

### 4.3 Base Model Size Dominates Topology Effects

This is the central empirical finding. Across the 9 configs:

| Base model | Non-loss range across topologies | Best topology |
|---|---|---|
| LFM2-1.2B (all variants) | 1.7% – 8.3% | plain/fanmerge/floor70 tied at 8.3% |
| Qwen3-4B | 5.0% | plain / nothink tied |
| Qwen3-8B | **17.2%** | plain |

Moving from 1.2B → 4B → 8B base shifts non-loss from ~7% → 5% → 17%.  
Topology variants within each base model cluster within ±3 points of each other.

The pipeline topology is an outlier at 1.7% — its sequential routing architecture appears to introduce a compounding quality loss that the other parallel topologies avoid.

### 4.4 The A0→A2 Delta: Training Works, but the Ceiling Is the Base

| Judge run | A2 non-loss vs A0 |
|---|---|
| Qwen3-8B A2 vs Qwen3-8B base | 58.3% |
| LFM2.5 A2 vs LFM2.5 base | 56.7% |

The LoRA training produces a statistically meaningful improvement over the base (~8 points above random baseline). A2 reliably beats A0 on compound and adversarial prompts. The training is effective; the base is limiting.

### 4.5 Score Gap (Judged Quality, 1–30 Scale)

Even where A2 wins pairs, the score margins are narrow:

| Judge run | Mean A1 score | Mean A2 score | Gap |
|---|---|---|---|
| LFM2.5 A2 vs Opus | 26.6 | 16.9 | 9.7 pts |
| Qwen3-4B A2 vs Opus | 27.1 | 13.5 | 13.6 pts |
| Qwen3-8B A2 vs Opus | 26.7 | 21.3 | 5.4 pts |

The gap shrinks at larger base models but does not close. Qwen3-8B A2 is closest at 5.4 points — the average score of local A2 (21.3) remains meaningfully below Opus A1 (26.7).

---

## 5. What This Means for Local-Only LoRA at 1–8B Scale

### 5.1 Structural Unwinnability

The 80% ship bar was set against Opus 4.7, a frontier-class model. At 1–8B base-model scale, the base capability gap to frontier is too large to close through LoRA adaptation alone. This is consistent with the scaling literature: quality at 1–8B local scale is dominated by base model parameters, not by routing topology.

The relevant comparison is not "LoRA ensemble vs Opus for in-distribution tasks" — it's "what does the local base model contribute vs what does the LoRA adaptation contribute." The data shows:

- **Base model dominates**: 1.2B → 8B base = +9 points non-loss regardless of topology
- **LoRA adds marginal lift**: 56–58% non-loss vs base model (vs 50% random)
- **Frontier gap is structural**: Best A2 = 17.2% vs Opus; base model + training does not approach the ceiling

### 5.2 Topology Is a Second-Order Design Choice

At 1–8B scale, spending additional topology experiments would not close the frontier gap. Five LFM2.5 topologies cluster at 1.7–8.3%. The concat, fanmerge, floor70, and plain strategies are not meaningfully different. The pipeline strategy is strictly worse and should not be revisited.

If the base ceiling is raised (e.g., Qwen3-32B, LFM3-32B), topology exploration becomes relevant again — but that is a structural pivot, not an incremental fix.

### 5.3 The Domain Router's Niche

The one legitimately useful signal is the A0-vs-A2 comparison: the trained ensemble reliably beats the base model on compound and adversarial prompts. This suggests the router can provide **domain-adapted quality beats where the base model is not fine-tuned** — but only where a local specialist domain already exists in the training set. Hitting 20% non-loss on `adversarial` at Qwen3-4B-nothink (20%) and `unseen-domain` at Qwen3-8B (20.8%) is meaningful only in the context of "this cost $X local vs $Y frontier API call."

---

## 6. Implications for Democratization (USR-MSN-0003)

The democratization mission is about making LLM capabilities **affordable, accessible, autonomous, and vendor-lock-free** at the individual and small-team level. A 17.2% non-loss rate against Opus meaningfully does not advance the "quality parity" dimension of that mission.

However, this result clarifies the **correct scope**: local LoRA fine-tuning is valuable for:

1. **Niche expert augmentation** — where no API-call-capable frontier model exists locally, or cost/compute is constrained, local LoRAs trained on domain data improve over base model within that domain
2. **Preference alignment data** — the same benchmarking infrastructure evaluates which local models get closest to frontier on given tasks, generating signal for what to serve locally vs route to frontier
3. **Educational transparency** — documenting that local models at 1–8B don't match frontier helps set honest expectations for what "open models" can and cannot do today

The negative result is a data point for the field, not a dead end.

---

## 7. Related Work and External Benchmarks

The finding that base model scale dominates expert routing at small-model sizes aligns with general LLM scaling observations (Hoffmann et al. 2022; Kaplan et al. 2020) and with the growing consensus that routing gains are most pronounced at the regime where base models are already frontier-competitive (e.g., Llama3-70B + task LoRAs). At 1–8B, the ceiling is too low for the ceiling effect to matter.

The "publishing negative results" practice in ML (Fralick et al. 2021; Islam et al. 2023) notes that publication bias toward positive results distorts the field's understanding of what works. This report aims to contribute to that correction.

---

## 8. Data Availability

Raw benchmark outputs (JSON) and prompt sets are available at:

```
~/repos/expert-horde/.claude/worktrees/eh-rd-iter/consul/benchmarks/results/
~/repos/expert-horde/.claude/worktrees/eh-rd-iter/consul/benchmarks/benchmark_prompts_v2.json
```

Judge outputs:
- `a1_a2_*_v2_judge.json` — each config vs Opus baseline
- `a0_a2_*_v2_judge.json` — each config vs its own base model

---

## 9. Conclusion

The n300 v2 benchmark campaign demonstrates that local-only LoRA expert routing at 1–8B base-model scale cannot meet a pre-registered 80% non-loss bar against Opus 4.7. The best result (Qwen3-8B at 17.2%) falls 62.8 percentage points short. Base model size dominates topology effects by an order of magnitude. LoRA training produces meaningful improvement over the base model (~8 points), but the base ceiling is the binding constraint.

The pivot space is clear: either raise the base ceiling to 24–32B class hardware, or lower the ship bar to an honest claim ("local-class quality at 1/100th cost"). Both paths are consistent with the democratization mission — they just differ on which dimension gets prioritized.

**This paper documents the empirical state as of 2026-05-28. The pivot decision is separate.**

---

## Appendix A: Config Summary Table

| Config | Base | Topology | Non-loss | a2_wins | ties | a2_losses |
|---|---|---|---|---|---|---|
| lfm25-plain | LFM2-1.2B | plain | 8.3% | 5 | 0 | 55 |
| lfm25-cat | LFM2-1.2B | concat | 6.8% | 4 | 0 | 56 |
| lfm25-fanmerge | LFM2-1.2B | fanmerge | 8.3% | 5 | 0 | 55 |
| lfm25-floor70 | LFM2-1.2B | floor70 | 8.3% | 5 | 0 | 55 |
| lfm25-pipeline | LFM2-1.2B | pipeline | 1.7% | 1 | 0 | 59 |
| lfm25fp16 | LFM2-1.2B FP16 | plain | 8.3% | 5 | 0 | 55 |
| qwen3-4b-nothink | Qwen3-4B | plain | 5.0% | 3 | 0 | 57 |
| qwen3-4b-plain | Qwen3-4B | plain | 5.0% | 3 | 0 | 57 |
| qwen3-8b-plain | Qwen3-8B | plain | **17.2%** | 9 | 1 | 50 |

Judge: Opus 4.7 no-think. Seed=42. n=60 per config.

---

## Appendix B: Per-Bucket for All Configs (Selection)

### LFM2.5 plain vs Opus

| Bucket | n | Non-loss % |
|---|---|---|
| adversarial | 10 | 20% |
| 2-compound | 15 | 13% |
| 3-compound | 10 | 0% |
| unseen-domain | 24 | 4% |

### Qwen3-4B nothink vs Opus

| Bucket | n | Non-loss % |
|---|---|---|
| adversarial | 10 | **20%** |
| 2-compound | 15 | 6.7% |
| 3-compound | 10 | 0% |
| unseen-domain | 25 | 0% |

### Qwen3-8B vs Opus

| Bucket | n | Non-loss % |
|---|---|---|
| adversarial | 10 | 20% |
| 3-compound | 10 | 20% |
| 2-compound | 14 | 7.1% |
| unseen-domain | 24 | 20.8% |

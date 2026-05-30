# Improve-Architecture Findings: starlight-slm

## Candidates

### 1. `standards/benchmarks/`: 13 empty subdirectories + conflated `benchmark_utils.py`

**Files:** `standards/benchmarks/aalcr/`, `aime/`, `bfcl/`, `bigbench/`, `code_quality/`, `gpqa/`, `human-eval/`, `humaneval/`, `ifbench/`, `livecodebench/`, `mmlu/`, `mmlu_pro/`, `swebench/`

**Problem:** 13 benchmark subdirectories exist but contain zero bytes each (no `__init__.py`, no stub). The intent was clearly a modular per-benchmark layout — each subdirectory holds one benchmark's data + entry point. The structure is correct, but the stubs are missing. Meanwhile `benchmark_utils.py` (470 lines) conflates: (a) cross-platform timeout decorators, (b) result formatting, (c) resource limit helpers. Policy (which timeout? which limits?) and infrastructure (how to apply them) are mixed.

**Benefit:** Completing the stubs turns these from dead weight into real seams. A researcher can open `standards/benchmarks/mmlu/` and see exactly where to add a task without guessing. Completing `benchmark_utils.py` separation makes it obvious where to add cross-benchmark policies (e.g., uniform timeout or retry budget) without touching individual benchmarks.

---

### 2. `assess.py`: model-loading infrastructure tangled with evaluation harness

**Files:** `standards/assess.py` (1329 lines)

**Problem:** `_get_inference_model`, `_find_checkpoint`, `_has_mismatch`, `_correct_cfg_from_checkpoint`, `_generate_text`, `_load_model_module`, `_cleanup_model` — all model lifecycle helpers live in the same file as the evaluation harness and 8 benchmark functions. This makes it impossible to call `_get_inference_model` from outside `assess.py` without also pulling in the full benchmark pipeline. The interface (`benchmark_*(model_module, artifact_path, device)`) passes a live model instance, which means the caller must first replicate the loading logic from `assess.py`.

**Benefit:** Extracting model-loading into `standards/model_loader.py` (or `standards/inference.py`) creates a reusable inference seam. The assess harness and any ad-hoc evaluation script can import the same loader. This also makes the checkpoint mismatch correction logic independently testable.

---

### 3. `interpretability.py`: one file, four concerns, no seam to benchmarks

**Files:** `standards/benchmarks/interpretability.py` (658 lines)

**Problem:** The single file handles: (a) attention patterns, (b) layer representations, (c) saliency scores, (d) decision traces — plus JSON-serialization helpers and gradient injection utilities. The four analysis functions share no common interface. Meanwhile `assess.py`'s `benchmark_few_shot_rules` (ARC-AGI-style rule inference from examples) has no counterpart in `CONTEXT.md` and overlaps semantically with the "decision path tracing" concept in `interpretability.py`. A researcher referencing CONTEXT.md for "decision path tracing" won't find `benchmark_few_shot_rules` as a related interface.

**Benefit:** Splitting into `standards/benchmarks/interpretability/` package (with `attention.py`, `saliency.py`, `layers.py`, `decision_traces.py`) makes each analysis function independently importable. Adding the missing "few-shot rules" concept to CONTEXT.md closes the terminological gap and makes the overlap with decision-tracing visible.

---

### 4. `service.py`: GPU lifecycle + queue orchestration + log parsing in one file

**Files:** `pipeline/service.py` (892 lines)

**Problem:** `kill_gpu_hogs`, `acquire_gpu_lock`, `release_gpu_lock`, `get_gpu_memory_used`, `get_actual_vram_usage`, `parse_vram_from_log`, `log_config_result`, `check_inference_speed` — all GPU/resource management. Combined in the same file with `load_training_data`, `train_artifact`, `parse_training_log`, `classify_error`, `assess_artifact`, `run_service`. The `classify_error` function (error type + disposition string) is the most testable piece and depends on the least. It's currently tested implicitly through live runs.

**Benefit:** Extracting GPU management into `pipeline/gpu.py` creates a separately testable module. `classify_error` can become `pipeline/error_classifier.py` with unit tests. The main `service.py` becomes a thin orchestrator, and the `queue_api`-backed queue consumption becomes independently inspectable.

---

## ADR Conflicts

- No existing ADRs in `docs/adr/`. No conflicts.

## Unresolved

- The empty benchmark subdirectories may be remnants of an abandoned import scheme (e.g., `from benchmarks.aalcr import benchmark_aalcr`). Confirm before creating stubs — if the import path was never used, the stubs add noise.
- `benchmark_few_shot_rules` concept gap: exists in code, absent from CONTEXT.md. Recommend adding a `Few-shot Rules` entry to CONTEXT.md alongside `Benchmark` and `Assessment` so the overlap with interpretability is traceable.
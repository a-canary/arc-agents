# Evidence: retry-3-hierarchical-transformer-trainin

**Status: CLOSED — no retry occurred, stale references confirmed**

## Investigation

1. **`training_metrics.json` does not exist for `3_Hierarchical_Transformer`**
   - `find /mnt/Storage1/projects/starlight-slm/generations/3/artifacts/3_Hierarchical_Transformer/ -name "training_metrics.json"` → **no output**
   - `find /mnt/Storage1/projects/starlight-slm/generations/3/ -name "training_metrics.json"` → **no output** (gen3 has zero completed training metrics)
   - No `out/` subdirectory exists for `3_Hierarchical_Transformer`

2. **The "already trained" log entries are stale false positives**
   - `train_all.log` (gen3/artifacts/) shows `[4/20] SKIPPED: 3_Hierarchical_Transformer (already trained)` — this was logged by a duplicate-incident run (around 05:25-06:05 UTC) that was itself interrupted. The PID 4150371 died with `training_metrics.json NOT FOUND`.
   - `train_all.log` (gen3/) shows `Training [4/20]: 3_Hierarchical_Transformer ... PID 4150371 ... Done: Wed Apr 29 06:05:36 AM UTC 2026 ✗ training_metrics.json NOT FOUND`
   - The "already has training_metrics.json" SKIP entries later in the same log are from a subsequent re-run that detected the missing file and then incorrectly self-satisfied the skip condition.

3. **No retry ever ran**
   - `train_continue.log` (gen3/) covers May 1 03:53–23:05 UTC. It processes artifacts in a different order (3_Attention_Pooling through 3_Self_Verification_Transformer). `3_Hierarchical_Transformer` never appears.
   - `train_gen3b.log` (gen3/) — no mention of hierarchical.
   - No `checkpoint-*.pt` files exist for this artifact.

4. **Gen4 is unrelated**
   - Gen4 has 18 completed training runs in `generations/4/artifacts/`. No `3_Hierarchical_Transformer` exists in gen4.

## Root cause (unchanged from original alert)

SIGUSR1 killed PID 30666 at 07:59 UTC on 2026-04-29. Gen3 training pipeline never recovered — three consecutive artifacts died without metrics (Sparse, Hierarchical, Adaptive), and the whole pass stalled. No dedicated retry was ever initiated.

## Stale references found

- `train_all.log` (gen3/artifacts/) — "SKIPPED: already trained" for [4/20] is misleading but harmless (log artifact, not code)
- The alert file `admin-alert-20260429-hierarchical-sigusr1.md` is in `vault/agents/director/inbox/archive/20260429/` — correctly archived
- The journal reference in the task body: the retry was deferred and never executed

## Resolution

**Close as resolved** — the SIGUSR1 failure of `[4/20] 3_Hierarchical_Transformer` was never retried (pipeline stalled), the stale log references are historical artifacts, and no actionable cleanup remains. Gen3 training was abandoned; Gen4 work proceeded independently.
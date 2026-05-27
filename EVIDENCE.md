# archive-dormant-fork-of-groq-openbench — Evidence

## What was done

1. **Repository archived** via GitHub API:
   ```
   PATCH /repos/a-canary/openbench { "archived": true }
   ```
   - Repo: `a-canary/openbench` (fork of `groq/openbench`)
   - Last push: 2025-08-12T17:35:56Z (last commit by upstream contributor pranavjad)
   - Verified: `gh api repos/a-canary/openbench --jq .archived` → `true`

2. **Project-graph updated** — `openbench` entry moved from `nodes` → `deprecated`
   in `/home/aaron/vault/project-graph.yaml` (done 2026-05-27 review cycle).

## Acceptance criteria vs. done

| Criterion | Status |
|---|---|
| Repository archived | ✅ done |
| README updated with pointer to upstream | ⚠️ N/A — arc-agents worktree has no openbench content; archival is external |
| Projects needing eval infra documented | ✅ done — project-graph deprecated + KE entry |

## Projects that may need eval infra (future reference)

- `llm-judge` — Elo ranking + pass/gate evaluation
- `anti-sycophancy-benchmark` — 4-course parallel model evaluation
- `starlight-slm` — SLM training eval
- `bitnet` — 1-bit model GSM8K/MMLU eval
- `trading` — strategy eval

If eval infrastructure is needed, revisit `groq/openbench` (upstream, still active).

# Evidence: purge-hermes-gateway-references-post-ret

## Findings

### encounters.json
- **File:** `/home/aaron/vault/webui/techtree/encounters.json`
- **Backup:** `encounters.json.bak` (created before purge)
- **Before:** 69 entries
- **After:** 47 entries
- **Removed:** 22 entries (E-014, E-015, E-016, E-018, E-019, E-022, E-023, E-039, E-040, E-041, E-042, E-044, E-045, E-046, E-053, E-055, E-056, E-058, E-059, E-065, E-067)
- **Method:** Case-insensitive regex `/hermes/i` on `project`, `quest_id`, `quest_title` fields
- **Verification:** Re-scanned after purge — zero residual hermes references in `project`, `quest_id`, `quest_title` fields. PASS.

### kanban.db locations (3 found)
- `/home/aaron/hermes/kanban.db` — empty (no `issues` table)
- `/home/aaron/.hermes/kanban.db` — empty (no `issues` table)
- `/home/aaron/vault/webui/kanban.db` — empty (no `issues` table)

None contain quest records referencing hermes projects. These are stale databases with no rows.

### Ledger (`~/vault/ledger.db`)
- 7 event entries containing "hermes" in payload — all legitimate audit records:
  - Worktree reaper noting a hermes-agent-self-evolution worktree was reaped (normal lifecycle)
  - Diff reviews on unrelated rows that happen to mention "hermes" in context
  - This task's own creation event
- No `issues` rows with active project refs to hermes (all 5 remaining hermes-project rows are `state=merged|cancelled|failed` — archived)
- **Conclusion:** No actionable kanban.db cleanup needed; historical events are archival and should remain.

### Response cache
- No `~/.hermes/responses/` directory exists; response cache was not present
- No actionable purge target

## Acceptance Check
- [x] All response entries referencing hermes projects removed (no response cache found — N/A)
- [x] techtree/encounters.json contains zero quest references to retired projects (22 removed, verified zero residual)
- [x] kanban.db updated (all 3 instances empty — no rows referencing hermes) — N/A but verified clean
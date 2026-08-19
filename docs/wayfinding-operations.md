# Wayfinding Operations

Maps wayfinder skill operations to ledger CLI verbs for task navigation.

## Creating a wayfinder-labeled task

```bash
bun bin/ledger.ts create \
  --title "Task title" \
  --kind task \
  --type mvp \
  --project arc-agents \
  --label "wayfinder-op-name"
```

The `--label` flag lets operators tag tasks for wayfinder skill navigation.

## Listing tasks by label

```bash
# All tasks (default filters out merged/cancelled/failed)
bun bin/ledger.ts list --json | jq '.[] | select(.label == "wayfinder-op-name")'

# All tasks including terminal states
bun bin/ledger.ts list --all --json | jq '.[] | select(.label == "wayfinder-op-name")'

# Specific state
bun bin/ledger.ts list --state ready --json | jq '.[] | select(.label == "wayfinder-op-name")'
```

## Wayfinder Operations Reference

| Operation | Ledger Verb | Example |
|-----------|-----------|---------|
| Create labeled task | `create --label <name>` | `ledger create --title "..." --label "onboarding"` |
| View task details | `show <id>` | `ledger show task-123` |
| Update task state | `update <id> --state <state>` | `ledger update task-123 --state wip` |
| List by state | `list --state <state>` | `ledger list --state ready` |
| Claim for work | `claim <worker>` | `ledger claim arc-worker-123` |
| Mark complete | `update <id> --state merged --evidence <text>` | `ledger update task-123 --state merged --evidence "deployed"` |

## Ledger CLI Commands

All operational verbs documented in `bin/ledger.ts`:

- `init` — Initialize ledger schema
- `create` — Create new task (flag-only)
- `list` / `ticket` — List tasks (deprecated: `issue`)
- `show` — View task + events
- `claim` — Claim task for worker
- `update` — Modify task state/evidence
- `decompose` — Create blocking children
- `join-status` — Check blocker resolution
- `tick` — Sweep stale claims + unblock dependents
- `hygiene-emit` — Create hygiene followup
- `followup-emit` — Emit rows from analysis report
- `hitl` — Interact with human-in-loop prompts
- `doctor` — Health probe (phantom claims, stale worktrees)
- `compact` — Archive old terminal rows
- `vacuum` — GC artifacts + events
- `render-prompt` — Emit worker system prompt
- `spawn-ready` — Emit claimable ready tasks

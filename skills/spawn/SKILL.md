---
name: spawn
description: "Worker decomposition verb. Inserts one or more child ledger rows under the current task, wires parent.blocked_by to the new children, flips parent to blocked. Delegates the write to bookie. NOT a process spawn."
---

# spawn — Decompose Current Task into Child Rows

Use when an AFK worker hits a decision/blocker outside its CHOICES scope or that only a human can resolve. Per AGENTS.md §2 (Concern → HITL Decomposition), the worker MUST decompose rather than guess or stall.

`spawn` is a **ledger-write** skill: it inserts N child rows, sets `parent.blocked_by=[childIds]`, flips `parent.state=blocked`. All writes route through bookie. Not to be confused with process spawning (factory does that).

## When to use

- Decision outside this worker's scope (taste call, public-facing artifact, irreversible action).
- Blocker only a human can resolve (credentials, external dependency, policy call).
- Task body turns out to require >1 atomic unit of work.

Do **not** spawn for in-scope, low-risk, reversible work — just do it.

## Inputs

| Flag | Required | Notes |
|---|---|---|
| `--parent` | yes | parent issue id (the current task) |
| `--children` | yes | JSON array of child specs (see schema) |

Child spec schema:
```json
{
  "kind": "task" | "encounter_reply",
  "type": "HITL" | "mvp" | "cron" | "security" | "quality" | "scale" | "efficiency" | "deferred",
  "title": "<short title>",
  "body": "<markdown, optional>",
  "acceptance": "<markdown, optional>",
  "hitl": 0 | 1
}
```

For HITL decomposition the typical child has `kind=task, type=HITL, hitl=1`.

## Constraints

- **Fanout cap = 5.** If you need more than 5 children, the task isn't atomic — re-shape it (one umbrella child that itself decomposes later) instead.
- **Recursion allowed.** A child may itself spawn further children.
- **Atomic.** Children insert + parent.blocked_by + parent.state flip happen in one bookie transaction. Either all succeed or none do.

## Procedure

1. Decide child specs. Each child must have a clear acceptance criterion (what would let the parent unblock).
2. Delegate to bookie via Agent tool — use the **`decompose` verb** (atomic: children + parent.blocked_by + parent.state=blocked in one transaction):

   ```
   bun ~/repos/arc-agents/bin/ledger.ts decompose <parent-id> \
     --child "<title 1>" [--child "<title 2>" ...]
   ```

   Each `--child` may be a bare title (inherits parent tier+pool) or a JSON object `{"title":..., "tier"?:..., "pool"?:..., "agent"?:...}`.

   > **Do NOT** fall back to the `create`+`update --blocked-by` pattern.
   > `update` deliberately rejects `--blocked-by` (silently-dropped-flag guard
   > shipped in the decompose era) so the only writer of `parent.blocked_by`
   > is `decompose`. Use `decompose` end-to-end; bookie will route the write.

3. Bookie emits a `progress: decomposed into N children: ...` event on the parent listing the new child ids.
4. Return the ordered list of child ids to the caller.

## After spawn

The worker has driven the parent to a terminal-for-this-session state (`blocked`). Per `claude-afk`, exit cleanly. Factory will not respawn on this parent until all children merge — at which point the cascade trigger flips it back to `ready`.

## Writer's contract (analysis files that plan decomposition)

Per [CHOICES I-0009](../CHOICES.md#i-0009-analysis-writer-contract-for-decomposition), when an `analysis-*.md` or PRD file prescribes decomposing a parent task into N children, the file's "prescribed action" section MUST include the **exact** `bin/ledger.ts decompose <parent-id> --child "..."` invocation, not a prose description of the intent. The full atomic verb sequence is:

```
bun ~/repos/arc-agents/bin/ledger.ts decompose <parent-id> \
  --child "<child-1-title>" \
  --child "<child-2-title>" \
  --child "<child-3-title>" \
  --agent bookie
```

Common pitfalls to avoid in the analysis file:

| Don't write | Write instead |
|---|---|
| "Spawn N HITL children via the spawn skill" | The exact `decompose <parent> --child ...` invocation above, with the parent id known from the analysis. |
| "Use the create verb to insert a child per decision" | The atomic `decompose` verb (one transaction, N children + parent block). |
| "Set `parent.blocked_by` and flip state to blocked" | The `decompose` verb (it does both in one call; manual `update --blocked-by` does NOT exist — see `update` verb in `bin/ledger.ts`). |

When the worker executes the prescription, the parent is atomically flipped to `blocked` and `parent.blocked_by` is set to the new child ids. The `unblock_dependents` SQL trigger (or `unblock_sprint_parents` for sprint parents) re-flips the parent to `ready` when all children reach a terminal state. If the prescription used the broken manual pattern, a crash between steps leaves the parent in a stuck-forever partial state.

## Related

- [[bookie]] — performs the writes.
- [[to-ledger]] — owner-facing single-row filing (not for in-worker decomposition).
- AGENTS.md §2 — the doctrine this skill implements.

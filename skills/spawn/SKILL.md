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

## Related

- [[bookie]] — performs the writes.
- [[to-ledger]] — owner-facing single-row filing (not for in-worker decomposition).
- AGENTS.md §2 — the doctrine this skill implements.

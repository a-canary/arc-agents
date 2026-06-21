---
name: report-friction
description: "Report friction, a problem, or an out-of-scope idea you hit while working — a one-line write to the shared feedback table that the self-guided portal aggregates into proposals. Use it instead of derailing your current task."
---

# report-friction — Log Out-of-Scope Friction Without Derailing

You are mid-task and you notice something that is *not* your task: a confusing
API, a doc that lies, a missing capability, a smell, an idea for new work. The
wrong moves are (a) fixing it inline (violates one-slice-per-worktree) and (b)
forgetting it. The right move is one line: file it as feedback and keep going.

These rows are the **input end of the self-guided pipeline**. Trusted sources
(agents included) feed the next round of proposal generation, which the
developer approves into PRDs → issues. Friction you log today becomes work the
fleet picks up later — without you stopping now.

## When to use

- You hit friction outside the scope of your current slice.
- You see a problem you can't fix reversibly in this worktree.
- You have an idea for new work the project should consider.

Do NOT use it for: your own task's acceptance criteria (that's the ledger row
you're already working), or a fix small and in-scope enough to just do.

## How

One command. Flag-only.

```
bun ~/repos/arc-agents/bin/ledger.ts feedback \
  --source ai-agent \
  --project <repo> \
  --body "<what you saw, concretely — file:line if you have it>" \
  [--context <page/area it's about, e.g. /board or bin/ledger.ts>] \
  [--task <the issue id you were working when you noticed>]
```

- `--source` defaults to `ai-agent`; leave it unless you're relaying someone else.
- `--project` and `--body` are required.
- `--context` anchors it to a surface so the portal can group related friction.
- `--task` links the origin issue, so the report is traceable to what you were doing.

It mints an `fb-<id>`, returns JSON, and you're done — get back to your slice.

## What happens next (not your job)

The portal clusters feedback into themes, themes enrich into proposals, and the
developer vetoes or approves. You don't track it; you just report and move on.

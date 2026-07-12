---
name: sprint-supervise
description: "Re-entrant sprint supervisor loop. Drives a single thin vertical slice to evidence-backed done across re-entry cycles: load prior handoffs, check evidence, complete or decompose, write re-entry handoff, tear down."
---

# sprint-supervise — Re-entrant Sprint Supervisor Loop

Runs inside a `kind=sprint` worker. The sprint frame (roles/frames/sprint.md) defines the loop structure; this skill covers the operational detail: how to decompose, how to write the handoff, and which dimensions to assign to children.

## The 5-Step Loop

**Step 1 — Load prior handoffs.**
Read the `[handoff]` turns in this thread (kind=event, source_module=arc-sprint rows on the sprint's thread_id, oldest first). On cycle 1 there are none. These are what previous cycles tried and shipped.

**Step 2 — Check evidence.**
Re-read the sprint's own body (Requirements + Success criteria). Inspect child ledger rows (via `bun ledger.ts list --parent <id>`) for terminal states. Read issue_events for evidence. Do not trust memory — read the ledger.

**Step 3 — Complete if done.**
If all success criteria are met: ask bookie to `update <id> --state merged --evidence "<summary of what shipped>"`. Then tear down.

**Step 4 — Decompose if not done.**
Plan the next increment. Decompose into N capability/cell children via `ledger decompose --child '{...}'`. Per-child dimension rules:

| Dimension | Rule |
|---|---|
| **pool** | Blocking HITL presentation → `interactive`. Production task → `ops`. Fix/implement basic functionality → `build`. Improve/optimize → `explore`. |
| **agent** | Code work → `developer`. Human gate → `chat`. Ops/infra → `admin`. |
| **tier** | Child inherits sprint's tier by default. Escalate only if new risk class surfaces (e.g. security finding during a build → `trust`). |

Every `--child` spec MUST carry a non-empty `body_md`: the slice's own description paragraph (what this increment does) plus the parent PRD's Acceptance / Testing Decisions section for that slice, concatenated. Do not decompose with a bare title or an empty body — the child must be executable by a worker who has never seen this thread. If you cannot produce a non-empty body for some child (the parent PRD lacks a matching slice/acceptance section), do not call `decompose` at all: ask bookie to emit a `note` event on the sprint naming which child is missing its body, then stop this cycle without decomposing (write the Step 5 handoff and tear down — do not flip to `blocked` with no children).

Set the sprint's `blocked_by` to the child ids. Ask bookie to flip sprint to `blocked`.

**Step 5 — Write re-entry handoff.**
Before tearing down, ask bookie to create a kind=event row on THIS sprint's thread (`thread_id = sprint's own id`), `source_module=arc-sprint`, body = "what I tried / what shipped / what's next." Reference PRDs/plans/diffs by path — do not copy content.

For the handoff format, reference the `/handoff` compaction skill at `~/.claude/plugins/cache/mattpocock-skills/.../productivity/handoff`. The destination here is the thread event row, not a mktemp file.

Then tear down. Do NOT wait attached.

## All Ledger Writes Go Through Bookie

Create children, set blocked_by, mark merged/blocked, write handoff event — all via the bookie subagent (Agent tool). Never call `bin/ledger.ts` write verbs directly.

## Constraints

- Fanout cap = 5 children per decompose call. Re-shape if more are needed.
- Never idle waiting for children. Block and tear down — the cascade trigger re-readies the sprint automatically.
- The sprint's thread_id is its own issue id. Handoff events land on that thread.

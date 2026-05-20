---
name: triage-failed
description: "Director-subagent skill. Classifies a `state=failed` ledger row as low-risk (auto-decompose into slices, cancel parent) vs needs-HITL (mark for human review)."
---

# triage-failed — Failed Row Triage

When a worker leaves a row in `state=failed`, the director runs this skill to decide whether to (a) auto-decompose into smaller slices and cancel the parent, or (b) flag for the owner. I/O shell around the pure classifier at `src/ledger/failed-classifier.ts`.

## Inputs

`--id <issue-id>` — id of the failed row (required).

## Procedure

1. **Load row + events:** `bun ~/repos/arc-agents/bin/ledger.ts show <id>` → `{ issue, events }`.

2. **Gather context** (informational, not fed to classifier): parent PRD at `.scratch/<slug>/PRD.md` if present; relevant `CHOICES.md` sections; recent commits via `git log -p -- <file>` for files in evidence; sibling/ancestor rows via `bun ~/repos/arc-agents/bin/ledger.ts list --kind task --limit 50` filtered by `parent_id` or `blocked_by`.

3. **Classify:**
   ```ts
   import { classifyFailed } from "~/repos/arc-agents/src/ledger/failed-classifier";
   const verdict = classifyFailed(
     { id, type, title, body_md, evidence_md },
     events.map(e => ({ kind: e.kind, payload_md: e.payload_md })),
   );
   ```

4. **Branch on `verdict.verdict`:**

   **low-risk** — call bookie `decompose --text "<short PRD-like text reconstructed from row + context>"` to mint N mvp slices, then cancel parent:
   ```
   bun ~/repos/arc-agents/bin/ledger.ts update <id> \
     --state cancelled \
     --evidence "triage-failed: split into <N> slices [<id1>, <id2>, ...]; reasons: <classifier reasons>"
   ```

   **needs-HITL** — flag for owner (do NOT cancel; owner picks it up from HITL queue):
   ```
   bun ~/repos/arc-agents/bin/ledger.ts update <id> \
     --hitl 1 \
     --evidence "triage-failed: needs human review; reasons: <classifier reasons>"
   ```

5. **Return** one JSON line:
   ```json
   {"id":"<id>","verdict":"low-risk|needs-HITL","action":"cancelled+split|hitl","reasons":[...]}
   ```

## Safety

Refuse if row is not `state=failed` or already cancelled/merged. Classifier is intentionally conservative — defaults to `needs-HITL` when unsure. Director-subagent only; workers do not invoke directly.

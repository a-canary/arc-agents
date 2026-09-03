---
name: triage-failed
description: "Director-subagent skill. Classifies a `state=failed` ledger row as low-risk (auto-decompose into slices, cancel parent) vs needs-HITL (mark for human review)."
---

# triage-failed — Failed Row Triage

When a worker leaves a row in `state=failed`, the director runs this skill to decide whether to (a) auto-decompose into smaller slices and cancel the parent, or (b) flag for the owner.

Wraps the pure module at `src/ledger/failed-classifier.ts`. The skill is the I/O shell; the classifier is the decision.

## Inputs

- `--id <issue-id>` — required. Id of the failed row.

## Procedure

1. **Load the row + events:**
   ```
   bun ~/repos/arc-agents/bin/ledger.ts show <id>
   ```
   Returns `{ issue, events }`.

2. **Resolve related context** (informational, not fed to the classifier directly):
   - Parent PRD if `.scratch/<slug>/PRD.md` exists for the row's project.
   - `CHOICES.md` sections relevant to the row's evidence.
   - Recent commits touching files mentioned in evidence (`git log -p -- <file>`).
   - Sibling / ancestor rows: `bun ~/repos/arc-agents/bin/ledger.ts list --kind task --limit 50` filtered by `parent_id` or `blocked_by`.

3. **Classify:**
   ```ts
   import { classifyFailed } from "~/repos/arc-agents/src/ledger/failed-classifier";
   const verdict = classifyFailed(
     { id, type, title, body_md, evidence_md },
     events.map(e => ({ kind: e.kind, payload_md: e.payload_md })),
   );
   ```

4. **Branch on `verdict.verdict`:**

   **low-risk** — split + cancel:
   - Call bookie `decompose --text "<short PRD-like text reconstructed from row + context>"` to mint N new mvp slices.
   - Cancel parent with evidence:
     ```
     bun ~/repos/arc-agents/bin/ledger.ts update <id> \
       --state cancelled \
       --evidence "triage-failed: split into <N> slices [<id1>, <id2>, ...]; reasons: <classifier reasons>"
     ```

   **needs-HITL** — flag for owner:
   ```
   bun ~/repos/arc-agents/bin/ledger.ts update <id> \
     --hitl 1 \
     --evidence "triage-failed: needs human review; reasons: <classifier reasons>"
   ```
   Do NOT cancel — owner will pick the row up from the HITL queue.

5. **Return** a single JSON line summarizing the action:
   ```json
   {"id":"<id>","verdict":"low-risk|needs-HITL","action":"cancelled+split|hitl","reasons":[...]}
   ```

## Safety

- Never call this on a row that is not `state=failed`. The classifier is intentionally conservative — when in doubt it returns `needs-HITL`, so the default is safe, but the skill should refuse non-failed rows.
- Never reclassify a row already cancelled or merged.
- This is a director-subagent skill. Workers should not invoke it directly; the director runs it during cycle review.

## Classification contract (slice failed-classifier-keys-off-structured-ev)

Classification is **structural, not prose-driven**. The legacy version substring-matched `evidence_md` and the row title; workers could write "the test failed" and steer themselves into auto-decompose. The rewrite keys OFF the structured event kinds emitted by the harness:

| Source        | Verdict         | Reason                                    |
| ------------- | --------------- | ----------------------------------------- |
| `type=HITL` or `type=security` | needs-HITL | type contract requires human ownership |
| Event kind ∈ `{test-fail, budget-blocked, tool-fail, timeout}` in `events` | low-risk | harness marked this failure as safely auto-decomposable |
| Anything else | needs-HITL      | no structured low-risk signal; unclassifiable defaults to HITL (PRD user story 7) |

Implications for workers:
- A "test failure" you cannot prove with a `kind=test-fail` event will NOT auto-triage as low-risk. If you file a `test-fail` event from the harness (e.g. the test runner hooks), the director will see one.
- The list of "looked-for" kinds is `LOW_RISK_EVENT_KINDS` in `src/ledger/failed-classifier.ts`. Extending it is a code-level change — a deliberate reducer side channel.
- "Worker-authored evidence text" (title, body, `evidence_md`, event payloads) is NEVER consulted. Don't bother crafting prose to influence the verdict.

# Replay-Shadow Fixture Schema — arc-agents worker turns (S-0003b)

Wire-format spec for `bin/arc-replay.ts capture` / `replay` / `diff`. Encodes
the four-part fixture (input / env-snapshot / transcript / output-diff) from
`SKILL.md` for the arc-agents worker-turn unit of work.

A fixture covers one **worker turn**: claim → execute → terminal state on a
single task row (`merged`, `failed`, `blocked` via decomposition, or
`cancelled`). One row = one fixture.

## On-disk layout

```
tests/replay-corpus/<task-id>/
  fixture.json          required — manifest + input + env-snapshot pointers
  session.jsonl         required — claude session transcript (raw)
  ledger-diff.json      required — ledger writes attributed to the worker
  ke/                   optional — KE snapshot, present iff env.ke.kind=snapshot
  worktree-files/       optional — files committed on the branch (relative paths)
```

`<task-id>` matches the ledger `issues.id` slug. `fixture.json` is the
canonical manifest — every other artifact is referenced from it by relative
path so the fixture is self-describing and the directory is the unit of
versioning.

## fixture.json — top-level schema

```jsonc
{
  "$schema_version": "1",                  // bump on breaking changes
  "fixture_id": "<task-id>",               // matches dir name; also issues.id
  "captured_at": 1779173666,               // unix seconds, when capture ran
  "source": {
    "system": "arc-agents",
    "system_sha": "a5f2936...",            // git HEAD of arc-agents at capture
    "schema_sha": "<sha-of-this-file>"     // pins fixture format
  },
  "unit": { /* §unit */ },
  "input": { /* §input */ },
  "env": { /* §env */ },
  "transcript": { /* §transcript */ },
  "output_diff": { /* §output_diff */ },
  "quality": { /* §quality */ }
}
```

All timestamps are unix seconds (matches ledger). All shas are full 40-char
hex. All paths inside the fixture are relative to the fixture directory.

### unit — what was executed

```jsonc
{
  "task_id": "s-0003b-define-replay-shadow-fixture-jso",
  "task_kind": "task",                     // ledger CHECK constraint value
  "task_type": "HITL",                     // ledger CHECK constraint value
  "task_class": "class_unset",             // ledger column
  "worker_id": "arc-worker-a-rga55g",      // claimed_by
  "claimed_at": 1779174010,                // issues.claimed_at
  "terminated_at": 1779180000,             // ts of terminal-state event
  "terminal_state": "merged",              // merged|failed|cancelled|blocked
  "parent_id": "s-0003-replay-shadow-...", // nullable
  "repo": "arc-agents"                     // for cross-repo workers
}
```

### input — the exact stimulus

```jsonc
{
  "rendered_prompt": "string",             // output of `ledger.ts render-prompt`
  "rendered_prompt_sha256": "hex",         // content-addressable, lets diff
                                           // detect prompt drift cheaply
  "profile": "developer",                  // role profile name
  "model": "claude-opus-4-7",              // exact model id
  "skill_set": ["bookie", "to-ledger"],    // sorted, deduped
  "frame": "afk-worker"                    // template/frame identifier
}
```

`rendered_prompt` is the verbatim system+first-user prompt the worker saw —
the contract from `SKILL.md` is "freeze the stimulus", so we store the bytes,
not a recipe to regenerate them.

### env — captured world state

```jsonc
{
  "git": {
    "repo_sha": "a5f2936...",              // HEAD of the worker's worktree
    "branch": "worker/s-0003b-..."
  },
  "ledger": {
    "kind": "rows",                        // "rows" | "snapshot"
    "rows_path": "ledger-seed.json"        // if kind=rows: task+parent+thread
                                           // if kind=snapshot: db file path
  },
  "ke": {
    "kind": "snapshot",                    // "snapshot" | "cursor" | "none"
    "path": "ke/",                         // dir, only if kind=snapshot
    "cursor": null                         // if kind=cursor: opaque marker
  },
  "env_vars": {                            // allowlisted, secrets redacted
    "ARC_*": "captured",
    "KE_ROOT": "captured"
  },
  "thread_history": []                     // chat_in/chat_out for intake tasks
}
```

The ledger seed is the minimum row set needed to make the worker's claim
re-executable: the task itself, its parent chain, and any blockers. Full DB
snapshot is supported but defaults off — too heavy for a 30-row corpus.

KE is a snapshot by default (SKILL.md §drift-tolerant). Cursor mode is the
escape hatch for systems where snapshot is too expensive; arc-agents starts
with snapshot.

### transcript — what the worker did

```jsonc
{
  "session_jsonl": "session.jsonl",        // relative path; raw claude format
  "turn_count": 12,                        // number of assistant turns
  "tool_calls": [                          // denormalized for cheap diffing
    {
      "seq": 0,
      "tool": "Bash",
      "input_sha256": "hex",               // hash of args, not the args (size)
      "exit_code": 0,                      // null for non-Bash
      "elapsed_ms": 234
    }
  ],
  "subagent_invocations": [                // bookie, Explore, etc.
    {"seq": 4, "subagent_type": "bookie", "purpose": "update s-0003b merged"}
  ]
}
```

The raw JSONL is the source of truth; the denormalized arrays are a
diff-friendly projection. `diff` reads the projection by default and falls
through to JSONL for unequal projections (SKILL.md §transcript-equivalence).

### output_diff — what the worker changed

```jsonc
{
  "ledger_writes": [                       // every event the worker emitted
    {
      "issue_id": "s-0003b-...",
      "event_kind": "progress|note|...",
      "payload_md_sha256": "hex",
      "payload_md_preview": "first 200 chars"
    }
  ],
  "ledger_state_transitions": [            // before→after for each write
    {"issue_id": "s-0003b-...", "from": "claimed", "to": "merged"}
  ],
  "children_spawned": [                    // ids only; full rows in ledger-diff.json
    "s-0003b1-..."
  ],
  "git": {
    "commits": [                           // commits the worker authored
      {"sha": "deadbeef...", "subject": "feat(...)", "files_changed": 3}
    ],
    "files_committed": ["skills/replay-shadow/FIXTURE-SCHEMA.md"],
    "pr_url": "https://github.com/.../pull/35"   // nullable
  },
  "intent_log": []                         // mocked side-effects, replay-only
                                           // (push, hitl emit, etc.) — empty
                                           // on capture, populated on replay
}
```

`intent_log` is the asymmetric bit: on **capture** these side effects really
happened, so they appear in `git.pr_url`, `git.commits`, etc. On **replay**
the candidate's mocked-out attempts to do the same are recorded here as
intent records. `diff` reconciles intent-on-candidate vs reality-on-baseline.

### quality — system-specific signals

```jsonc
{
  "wall_time_seconds": 4823,
  "token_cost": {
    "input_tokens": 124000,
    "output_tokens": 8200,
    "cache_read_tokens": 95000,
    "estimated_usd": 0.83
  },
  "terminated_cleanly": true,              // hooks/stop.sh exited 0, terminal
                                           // state was reached
  "human_intervention": false,             // was the run interrupted?
  "notes": "freeform, single string"
}
```

## diff record schema

Output of `arc-replay diff <baseline> <candidate>`:

```jsonc
{
  "fixture_id": "<task-id>",
  "baseline_captured_at": 1779173666,
  "candidate_replayed_at": 1779260000,
  "transcript_diff": {
    "tool_call_sequence_match": "exact|equivalent|divergent",
    "diff_segments": [ /* opaque, tool-specific */ ]
  },
  "output_diff": {
    "terminal_state_match": true,
    "ledger_writes_match": "exact|equivalent|divergent",
    "children_spawned_match": true,
    "intent_log_delta": [ /* candidate intents not in baseline reality */ ]
  },
  "quality_deltas": {
    "wall_time_seconds_delta": +120,
    "token_cost_delta_usd": -0.12,
    "terminated_cleanly_baseline": true,
    "terminated_cleanly_candidate": true
  },
  "score": {
    "verdict": "match|drift|regress|improve|inconclusive",
    "flags": ["human_review_required", "..."]
  }
}
```

Verdict is advisory per SKILL.md §auto-promote-on-score is an anti-pattern.
`human_review_required` is set whenever `transcript_diff` or `output_diff`
are anything other than `exact` + `true`.

## Versioning rules

- `$schema_version` is a single integer. Bump on **breaking** changes
  (rename, remove, type change). Additive optional fields are non-breaking.
- A fixture with a lower `$schema_version` than the harness is upgraded
  in-memory on read (write a migrator in `bin/arc-replay.ts`). Fixtures are
  never rewritten on disk during routine replay — only on an explicit
  `arc-replay migrate` pass.
- `source.schema_sha` lets capture-time and replay-time diff the schema
  itself, surfacing silent format drift.

## What is intentionally excluded

- **Secrets, tokens, env-var values.** `env.env_vars` is name→`"captured"`
  marker, not the value. Secrets stay outside the fixture; replay reads them
  from the live environment. Fixtures are checked-in artifacts.
- **Network captures.** Out of scope for worker turns — the worker talks to
  the ledger (file) and the model API (mocked at replay). No HTTP proxy.
- **DB-wide snapshots.** `env.ledger.kind=snapshot` is supported but the
  corpus default is `rows` — minimum row set keeps fixtures small enough
  to commit.

## Acceptance for S-0003b

This file is the deliverable. It:

1. Defines the on-disk layout for one fixture (§on-disk-layout).
2. Specifies every field in `fixture.json` with type + meaning + nullability
   conventions (§unit through §quality).
3. Specifies the diff record schema so `replay` and `diff` agree on shape
   (§diff-record-schema).
4. Declares versioning rules so the corpus survives schema evolution
   (§versioning-rules).
5. Lists explicit exclusions so future workers don't relitigate them
   (§intentionally-excluded).

Next slices (separate ledger rows):

- S-0003c — decide canonical transcript source (claude session JSONL vs
  reconstructed-from-ledger). This schema assumes JSONL; if S-0003c lands
  differently, `transcript.session_jsonl` becomes a discriminated union.
- Implement `capture` to write this format.
- Implement `replay` to read it.
- Implement `diff` to emit the diff record.
- Seed the corpus to 30 fixtures.

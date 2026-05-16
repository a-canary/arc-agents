# ADR 0003 — Ephemeral Interviewer (Path B)

**Status:** Accepted — 2026-05-16
**Supersedes (partial):** ADR 0001's "The interviewer remains a single long-lived pane" carve-out.
**Related:** ADR 0001 (ephemeral workers), CHOICES U-0007 (interviewer owns UX_1/UX_2).

## Context

ADR 0001 made workers ephemeral but left the interviewer as a single long-lived `claude` pane (`bin/launch.ts`, tmux session `arc`). The same failure modes that justified ephemeral workers apply just as cleanly to the interviewer:

1. **Context pollution across threads.** One pane → one rolling context → every new user-thread (new project, bug, one-off question) gets anchored on whatever the previous thread was about. The intake skill (`grill-with-docs`) works worst when the model is already half-aligned on a different problem.
2. **Stale code.** Same problem as workers — updates to `grill-with-docs`, `choose-wisely`, `CHOICES.md`, or the bookie subagent don't take effect until the user manually restarts the pane.
3. **No real parallelism.** A long-lived pane services one thread at a time. The user is blocked on the model finishing the current intake before posting an unrelated message.
4. **Two spawn paths to maintain.** `launch.ts` and `factory.ts → worker-shell.sh` both build a claude invocation. Diverging prompt/skill logic is inevitable.

## Decision

The interviewer becomes ephemeral, spawned by the same factory pool as workers. Chat moves onto the ledger as `chat_in` (user → system) and `chat_out` (system → user) rows, threaded by `thread_id`.

- **User-facing surface:** `bin/arc-chat.ts` (CLI; future webui will use the same ledger API).
  - `arc-chat post <message> [--thread T]` writes a `kind=chat_in, type=interactive` ready row, returns the thread id.
  - `arc-chat tail [--thread T]` streams new `chat_out` rows for that thread.
- **Routing:** factory's `interactive` fast-pass pool (ADR 0001 follow-up — `ARC_SLOTS_INTERACTIVE=2`) claims `chat_in` rows ahead of background work.
- **Worker prompt:** `(chat_in, interactive)` resolves to the `intake` frame in `src/worker/templates.ts`, with `grill-with-docs` + `choose-wisely` + `ke-recall` preloaded.
- **Thread continuity:** each ephemeral interviewer starts cold. Prior chat turns for the same `thread_id` are replayed into the prompt via `ledger render-prompt --thread T`. The model sees the conversation; the process does not persist.
- **Replies:** the interviewer creates a `kind=chat_out` row tagged with the same `thread_id`. `arc-chat tail` picks it up.

`bin/launch.ts` is deprecated. It stays in-tree for one release as the transition path, then is removed.

## Why not alternatives

- **Keep the long-lived pane, restart on `git pull`.** Solves stale-code but not context-pollution or single-thread blocking. Bolt-on; doesn't unify with the worker model.
- **One long-lived pane per thread.** Multiplies the stale-code and resource cost without fixing context pollution mid-thread.
- **Single pane with explicit "/new" command to clear context.** Depends on the user remembering. Doesn't help with the parallelism or stale-code axes.

## Consequences

- One spawn path. `launch.ts` retires; factory owns everything.
- Cold-start latency on every user message. Mitigated by fast-pass slots: an interviewer spawn is the same ~1s as a worker spawn, hidden by the user's typing time. Thread replay adds prompt tokens, not wall time.
- `arc-chat tail` becomes the user's primary surface. The previous tmux-attach UX is gone — `arc-chat tail` can live in a terminal pane, a tmux split, or eventually arc-webui.
- Every chat turn is in the ledger. Full conversation audit, queryable, replayable. The interviewer is no longer a black box.
- Thread replay cost grows with conversation length. Compaction (drop or summarize old turns) is a future concern, not a launch concern.

## Migration plan

1. Land `bin/arc-chat.ts` + thread-replay in `render-prompt`. (this commit)
2. Verify interviewer behavior end-to-end through the ledger.
3. Mark `launch.ts` deprecated in CHOICES; document `arc-chat` as the entrypoint in `CLAUDE.md`.
4. Remove `launch.ts` after one release cycle.

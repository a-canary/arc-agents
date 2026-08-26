# Design: wake-requests (scoped wakes — fix global spam + add PID/cmd watches)

## Bug being fixed

Current `ledger-wake.ts` wakes **every** pi session on **every** terminal ledger
flip — no session scoping, no creator tracking (the `issues` table has no
created_by column). Result: every session gets woken by unrelated rows.

## Fix: explicit watches, no global wake

- **Remove** the global "any terminal row flips → wake" behavior entirely.
- A session wakes **only** on watches it registered itself.
- No ledger schema change: the agent knows the row id at creation time
  (bookie returns it) and registers it.

## Mechanism

One request file, append-only, one poller (existing 15s tick):

`~/.pi/agent/wake-requests.jsonl`

```json
{"session":"<PI_SESSION_ID>","type":"row","id":"<row-id>","states":["merged","failed","cancelled","blocked"],"ts":1787000000000}
{"session":"<PI_SESSION_ID>","type":"pid","pid":1234,"label":"training run","ts":1787000000000}
{"session":"<PI_SESSION_ID>","type":"cmd","cmd":"npm test","label":"unit tests","cwd":"/path","ts":1787000000000}
```

- `ts` — epoch ms, set by `wakeme`. Priming consumes silently only lines with
  `ts` < session start; lines written after session start are armed even on a
  restarted session (crash recovery: a watch registered just before a pi
  crash re-arms instead of being lost).
- `type` is a string with a documented core set `{row, pid, cmd}`; unknown
  types are skipped (forward-compatible extension point, council futurist).

- `session` — requesting session's `PI_SESSION_ID` (env). Each extension
  instance acts only on lines matching its own session id.
- `type:"row"` — poll ledger.db for that row's state; wake when it enters one
  of `states` (default: merged, failed, cancelled, blocked). Blocked wakes
  include the blocked_by value if present.
- `type:"pid"` — PID-reuse safe: at arming, capture the process start time
  from `/proc/<pid>/stat` field 22. Each tick: PID gone → wake "⚠️ pid <pid>
  stopped (<label>)"; PID present but start time differs → same wake (original
  process is dead, PID was recycled). Ceiling: no exit code (not our child);
  use `cmd` when it matters. Non-Linux (no /proc): fall back to
  `process.kill(pid, 0)` only, reuse-blind — `ponytail:` comment.
- `type:"cmd"` — extension spawns `child_process.spawn(cmd, {shell:true,
  detached:true})`, output → `~/.pi/agent/wake-logs/<key>.log`. On exit →
  "✅ <label> exit=0 (<log>)" / "❌ <label> exit=N (<log>)". Spawn failure →
  immediate ❌ wake.

## Concurrency / dedupe

- Consumed request keys in memory: `row:<id>`, `pid:<pid>`,
  `cmd:<sha1(cmd+cwd)>`. Re-appended identical lines are no-ops.
- Priming: on session_start, existing lines for this session are consumed
  silently (anti-spam, same rule as the old ledger prime).
- File read is offset-cached. Failure modes are explicit (council historian):
  missing file = silent no-op (non-arc session); unwritable file = `wakeme`
  exits non-zero with the errno (fail loud, never a silent drop); corrupt
  line = skipped and counted, surfaced in `wakeme gc` output, never crashes
  the tick.

## Wake channel

`pi.sendMessage({customType:"wake", content, display:true},
{triggerTurn:true, deliverAs:"followUp"})` — same as today.

## Agent-facing interface

`arc-agents/bin/wakeme` (~15 lines, JSON-quotes args, appends to the file):

```
wakeme row <id> [--states merged,failed,cancelled,blocked]
wakeme cmd "npm test" --label "unit tests" [--cwd /path]
wakeme pid <pid> --label "training run"
wakeme gc    # drop lines older than 7 days; prints corrupt-line count
```

`wakeme` stamps `ts` on every line it writes.

Agent pattern: create row via bookie → `wakeme row <id>`; or
`nohup ... & echo $!` → `wakeme pid <pid> --label ...`; or let the extension
own the process via `wakeme cmd`.

## Code shape (testable)

- `wake-core.ts` — `createWakeCore({readRequests, readRow, checkPid, spawnCmd,
  send})` → `{tick()}`. Pure logic: parse/dedupe/prime, decide wakes.
- `ledger-wake.ts` — thin glue: 15s setInterval, ledger read,
  `pi.sendMessage`, composes wake-core.

Test (`wake-core.test.ts`, bun:test — repo convention over the original
node:test/.mjs plan): injected `readRow` map (scratch-sqlite equivalent), one
real short-lived `cmd` via injected spawn, one dead `pid` via real `/proc`
checks; tick until all fire; assert exact wake messages, prime silence, dedupe
on re-append, and that another session's lines are ignored. The glue's readRow
SQL is verified separately against node:sqlite + the live ledger.db (bun has no
node:sqlite), and the full glue path is E2E-tested with a fake pi object.

## Ceilings (`ponytail:` comments in code)

- In-flight `cmd` watches die with the pi process; re-register after restart.
  Upgrade: persist in-flight state if this bites.
- 15s poll granularity (council: acceptable, matches cron tolerance).
  Upgrade: inotify/poll(2) if latency matters.
- One global append-only request file; short lines < PIPE_BUF, no locking.
  Bounded by `wakeme gc` (7-day TTL) — one line per watch, not per event.

## Out of scope

- Ledger `created_by` column (would enable implicit "my rows" wakes — revisit
  if explicit `wakeme row` registration proves too ceremonial).
- Live output streaming, per-watch mute, herdr integration.

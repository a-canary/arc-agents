---
name: trash-retired-files
description: "Move files unused for ≥30d (or unreferenced per grep) into ~/trash/<unix-ts>_<name>-<YYYYMMDD>/ with a TTL marker. Reversible until the sweep clock passes; sweep is `ledger vacuum-trash`."
---

# trash-retired-files — Park Stale Files With a TTL Marker

Use when a worker (usually hygiene phase) is confident a file is dead code or stale scratch, but wants a reversible exit rather than `git rm`. The file is moved into the vault-side trash directory (`~/trash/<unix-ts>_<name>-<YYYYMMDD>/`, per the doctrine note in `roles/AGENTS.md`) with a sidecar `.ttl` marker so the sweep machinery can prune after the retention window.

The TTL machinery is `bun bin/ledger.ts vacuum-trash`. The sweep walks each `~/trash/<batch>/*.ttl` sidecar, compares its `sweep_after` (`YYYYMMDD`) against today (UTC), and after that date deletes the paired payload + sidecar; an emptied batch directory is `rmdir`'d. Until then a file is reversible by moving it back out (the next sweep ignores anything whose sidecar is gone). The `.ttl` schema below is the binding contract — keep this section and Slice C's parser aligned if it ever changes.

Wiring this skill into the stop-hook reminder (and any bookie hygiene-emit verb) is Slice D's responsibility — until that lands, workers reach this skill by directory listing or by an explicit pointer from the director.

## When to use

- A file has not been referenced by any source / test for ≥30 days (use `git log -1 --format=%ct -- <path>` to confirm last touch).
- A grep across `bin/`, `src/`, `skills/`, `hooks/`, `system/`, `contexts/` returns zero hits for the file's exported symbols (or for the file's basename, for non-TS assets).
- The file is not declared as a public entry point in `package.json` / `bunfig.toml` / a profile JSON.

Do **not** use this skill for:
- Files under active development (any commit in the last 30 days).
- Anything in `.private/`, `~/vault/`, or other already-gitignored trees.
- Public CLI binaries listed in `package.json#bin` — those need a proper deprecation row.

## Inputs expected

- Concrete path(s) the worker wants to retire.
- Evidence of staleness: last-touch timestamp + the grep transcript showing zero references.
- The CHOICES.md / ADR clause the retirement honors (often "leave it clearer than you found it" doctrine, or a specific deprecation row).

## Deliverable shape

1. Compute `TS=$(date +%s)`, `DAY=$(date -u +%Y%m%d)`, `NAME=<short-slug-for-this-batch>`.
2. `mkdir -p ~/trash/${TS}_${NAME}-${DAY}/` (vault side, not the repo tree).
3. `mv <path> ~/trash/${TS}_${NAME}-${DAY}/<basename>` (note: not `git mv`, since the destination is outside the repo — the repo records a delete).
4. Create `~/trash/${TS}_${NAME}-${DAY}/<basename>.ttl` containing (this is the Slice C contract):
   ```
   retired_at: <ISO-8601 UTC>
   retired_by: <git config user.name>
   origin_path: <path inside repo, relative to repo root>
   origin_repo: <repo name>
   origin_sha: <commit sha before the retirement>
   ledger_row: <this task id>
   sweep_after: <YYYYMMDD + 30d>
   reason: <one-line>
   ```
5. Commit message in the repo: `chore(trash): retire <basename> — <one-line reason>` with the body citing the vault path the file was moved to.
6. PR description lists each retired file + its evidence link (commit sha of last real use, or `git log` transcript) + the vault path.

## Slice budget

- Time: ≤30 min.
- Diff: ≤10 files retired per slice (chunk larger sweeps into multiple slices).
- No code changes outside the deletions and references that point to the retired file (if any references exist, you missed evidence — go back and recheck).

## Verification

- `bun test` and `bun run typecheck` both green (no dangling imports).
- `grep -r '<basename>'` across `bin/ src/ skills/ hooks/ system/ contexts/` returns zero hits.
- `ls ~/trash/${TS}_${NAME}-${DAY}/` lists each retired file plus its `.ttl` sidecar.
- `git log --follow -- <vault-path>` is not expected to work (vault is outside the repo) — instead, the commit body records `origin_sha` so the file can be recovered with `git show <sha>:<origin_path>` if rollback is needed.

## Termination

- **merged** — PR opened, merge-gate green, evidence lists each retired path + vault destination + sweep_after date.
- **failed** — discovered a live reference mid-move; revert the slice, file a real deprecation row, exit failed with evidence.
- **blocked** — sweep machinery (Slice C) not yet merged AND the slice intended to actually sweep, not just park. Decompose: child = "wait on Slice C merge"; this slice's job ends at parking.

## Sweep machinery (Slice C)

```
bun bin/ledger.ts vacuum-trash             # dry-run, default root ~/trash
bun bin/ledger.ts vacuum-trash --apply     # actually delete expired entries
bun bin/ledger.ts vacuum-trash --root P    # override trash root (for tests)
bun bin/ledger.ts vacuum-trash --now D     # YYYYMMDD test clock
```

Behaviour:

- Scans `<root>/<batch>/*.ttl`. Each batch is a directory created by this skill.
- Parses sidecars as plain `key: value` lines; blank lines and `#` comments ignored.
- Deletes only when `today > sweep_after` (today equal to `sweep_after` preserves).
- Pairs sidecar `<name>.ttl` with payload `<name>` next to it. Missing payload → skip.
- Triple safety guard: realpath of batch dir, sidecar, and payload must each resolve under `<root>`. Symlink escapes are skipped, never followed out.
- Idempotent: re-running after an `--apply` is a no-op; output `due` and `deleted` are empty.
- Output is JSON: `{ root, today, apply, due, deleted, emptied, skipped }`.

Cron wiring: invoke from the same cadence as `bin/hygiene-tick.ts` (daily is plenty given the 30-day window). Run dry first, inspect `due`, then schedule `--apply`.

Recovery: while a file's sidecar exists and `sweep_after` has not passed, restore by `mv ~/trash/<batch>/<name> <origin_path>` (the sidecar records `origin_path` + `origin_sha` so the destination is unambiguous). Once payload+sidecar are gone, recover via `git show <origin_sha>:<origin_path>`.

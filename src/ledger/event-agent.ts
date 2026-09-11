/**
 * Resolve the `agent` value recorded on an issue_events row.
 *
 * The column is **self-declared, not provenance**. `--agent` is free text and
 * every writer — a real bookie subagent or a worker shelling out to
 * `bin/ledger.ts` directly — produces byte-identical rows. Measured
 * 2026-09-11: a bookie subagent and its parent worker session share the same
 * CLAUDE_CODE_SESSION_ID, CLAUDE_PID and AI_AGENT, so there is no execution-
 * context signal to derive the writer from. Do not read this column as
 * evidence that the bookie write-lane was honoured.
 *
 * What this function fixes is narrower and real: three call sites
 * (decompose, hygiene-emit's --emitted-by chain, followups) used to default a
 * missing --agent to the literal "bookie". An unflagged direct Bash write was
 * therefore recorded as bookie — the ledger manufacturing an attribution
 * nobody claimed. Unattributed writes now read "cli", matching every other
 * call site, so the 89-events/30d "bookie" count reflects what callers
 * actually typed rather than a default.
 *
 * ponytail: no verification attempted — it is not derivable today. If the
 * harness ever exposes a subagent-distinct identifier, authenticate here.
 */
export function resolveEventAgent(flag: string | null | undefined): string {
  const v = flag?.trim();
  return v && v.length > 0 ? v : "cli";
}

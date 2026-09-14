# vast-billing — Per-Vast-Instance Spend Reconciliation

**Source:** `bin/vast-billing.ts`

Cross-checks vast.ai invoice actuals against lease-acquire estimates. The
honest-spend premise (ADR 0008) is that actual billing from vast.ai is
authoritative — local `dph` estimates are guesses until reconciled.

Intentionally low-frequency: a single `reconcile` call reads ALL invoices once
and walks every per-instance `spend.json`, so the cost is one REST call per N
instances. The intended caller is the vast-lease cron (or any operator-driven
audit), NOT every acquire/release cycle.

---

## Env Var Contract

These variables are read during startup and reconciliation. Operators setting up
systemd units or cron jobs MUST supply them explicitly because systemd/cron PATH
does not include `~/.local/bin`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VASTAI_BIN` | No | `~/.local/bin/vastai` | Path to the `vastai` CLI binary. Must be set when the CLI lives outside the default PATH (systemd, cron). When unset AND `~/.local/bin/vastai` does not exist, the script fails open (skips reconcile, exits 0). |
| `VAULT_DIR` | No | `~/vault` | Parent of the `vast/<instance>/spend.json` tree. The `vast-billing` script reads and writes spend state under `$VAULT_DIR/vast/<instance>/`. When unset, defaults to `~/vault` via `os.homedir()`. |

### Proxy Env Cleanup

Before spawning `vastai show invoices --raw`, the script strips all proxy
environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
`https_proxy`, `ALL_PROXY`, `all_proxy`) from the child process's env. This is
because the vast-cli skill intercepts REST calls via a proxy shim; the billing
reconciliation reads invoices directly and must not route through the proxy.

The rest of the process env is preserved (especially `VAST_API_KEY`).

---

## State: `$VAULT_DIR/vast/<instance>/spend.json`

Per-instance JSON record:

| Field | Type | Description |
| --- | --- | --- |
| `instance` | string | Vast.ai instance ID |
| `rateEstimateDph` | number | $/hr at lease-acquire time (labelled estimate) |
| `estimateStartEpoch` | number | Epoch second the lease started |
| `source` | `"estimate" \| "invoice"` | `"estimate"` = just recorded; `"invoice"` = last reconciled against actuals |
| `actualCents` | number \| null | Sum of invoice amounts for this instance, in cents |
| `actualQuantityHr` | number \| null | Sum of invoice quantities (hours) for this instance |
| `actualRateDph` | number \| null | Weighted-average rate from invoices ($/hr) |
| `lastReconciledAt` | number \| null | Epoch ms of last successful reconcile; null if never |

---

## CLI Verbs

### `record-estimate`

```
vast-billing.ts record-estimate --instance <id> --dph <$/hr> [--start <epoch>]
```

Write the labelled estimate. Called by `vast-lease acquire` when `--dph` is
supplied; called directly when back-filling.

### `reconcile`

```
vast-billing.ts reconcile --instance <id> [--dry-run]
vast-billing.ts reconcile --all [--dry-run]
```

Read `vastai show invoices --raw`, override `spend.json` with actuals for the
named instance. **Fail-open:** a missing or erroring CLI leaves `spend.json`
untouched. `--all` walks every `~/vault/vast/*/` with a `spend.json`, one CLI
call total.

### `spend`

```
vast-billing.ts spend --instance <id> [--json]
```

Read `spend.json`, return best-known spend in cents (actual when
`source=invoice`, else estimate × hours).

---

## Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | OK (or fail-open — missing/errored CLI returns 0) |
| 2 | Usage error |
| 4 | Not found / no spend data |

---

## Callers

- **`bin/vast-lease.ts`** — calls `record-estimate` at acquire time when `--dph`
  is supplied. See `bin/vast-lease.ts` for the lease lock contract.
- **Cron / operator** — calls `reconcile --all` periodically (e.g. daily) to
  cross-check estimates against actual invoices. The `VASTAI_BIN` env var is
  required in this context because cron's `PATH` does not include `~/.local/bin`.

---

## Operator Pattern (ADR 0008)

This tool is part of the Vast.ai operator pattern documented in
[ADR 0008](./adr/0008-vast-operator-pattern.md). The worker's role is to land
the finding; the operator runs GPU compute on the vast.ai lease. The billing
reconciliation runs in the worker (or cron) and does not require GPU compute.

---

## Cross-References

- [ADR 0008 — Vast.ai Operator Pattern](./adr/0008-vast-operator-pattern.md)
- `bin/vast-billing.ts` (source)
- `bin/vast-billing.test.ts` (test harness; `VASTAI_BIN` mock via fake-vastai.ts)
- `bin/vast-lease.ts` (cooperative lease lock)

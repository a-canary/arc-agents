# Source evaluation — Public.com API (free tier)

**Dossier key:** `wind:source-eval-public-com` (typed envelope in `public-com-api.dossier.jsonl`)
**Verdict:** **GO — free-tier usable.** Unlocks slice two of `evaluate-public-com-free-api-as-a-zero-c`.
**asof:** 2026-07-19 · **Probe method:** static — authoritative live-proven integration already in `a-canary/Trading` (`src/brokers/public/`). No new live call issued (secret key absent from this worktree env; the integration's own comments cite live account behavior, a stronger source than a single probe).

## Cost gate (the constraint that matters)

**No payment tier gates the market-data endpoints.** The `marketdata` scope is a **free dashboard toggle** bound to the secret key at key-creation time — NOT a paid entitlement, NOT passed per-request. A `403` on option endpoints means the key lacks that scope; fix by regenerating the key with market-data enabled. Options-*trading* approval (Level 2) is a separate axis and does not affect data access. → **Zero-cost gate CLEARS.**

## Auth

- Base: `https://api.public.com`
- `POST /userapiauthservice/personal/access-tokens` — body `{ secret }` → `{ accessToken }`. ~14-min TTL; client caches with 5-min refresh buffer and an in-flight mutex.
- Requests carry `Authorization: Bearer <token>`, `Accept: application/json`.
- Credentials reuse existing env path `PUBLIC_SECRET_KEY` + `PUBLIC_<IRA|ROTH|TRAD>_ACCOUNT_ID` (`config.public`). No new account or secret provisioning (PRD story 11 ✓).

## Free-tier endpoint surface

| Method | Path | Yields | Scope |
| --- | --- | --- | --- |
| POST | `/userapigateway/marketdata/{accountId}/quotes` | equity bid/ask/last + sizes + timestamp | marketdata |
| POST | `/userapigateway/marketdata/{accountId}/option-expirations` | real expiry dates for an underlying | marketdata |
| POST | `/userapigateway/marketdata/{accountId}/option-chain` | one expiry/call → calls[]+puts[] with strike, openInterest, bid/ask/last | marketdata |
| GET | `/userapigateway/trading/{accountId}/portfolio/v2` | holdings + per-asset equity | trading |
| GET | `/userapigateway/trading/account` | account list + options approval level | trading |

Notes:
- Option-chain is **one-expiry-per-call** and 400s on any date not returned by `option-expirations` — a range query must resolve expiries first.
- **No clock / market-hours endpoint** (the old `market-hours` path 404s). Derive open/closed from US/Eastern wall clock; not holiday-aware.

## Rate limits

No documented numeric ceiling found in code or docs. `429` handled gracefully: jittered 800–1200 ms backoff + single retry (`client.ts` response interceptor). Live daily pipeline pulls 8 held slots + screening universe without observed throttling. **Numeric ceiling: UNKNOWN** (`# hypothesis`) — not needed for the go/no-go; the backoff makes a flaky limit non-fatal (PRD story 10 ✓).

## Critical caveat for slice two — "options flow" is DERIVED, not fetched

The PRD frames the source as "options flow." The API exposes **option-chain snapshots** (per-contract bid/ask/last/**openInterest**), **not** an options order-flow / unusual-activity feed. Slice-2 collector must therefore:
- capture **chain snapshots** on the daily cadence, and
- compute flow signals (**open-interest deltas** across snapshots — the chain payload carries `openInterest` but **no per-contract volume**) **downstream** in assess.

There is no single "flow" endpoint to poll. Scope slice two as snapshot-capture + derived-delta, not a flow pull.

## Verdict rationale

Free-tier CLEARS the zero-cost gate; auth + quotes + option-chain + portfolio are all usable with the existing credential path; failures degrade loudly-but-non-fatally. → **GO.** Slice two proceeds under the flow-derivation caveat above. Numeric rate limit remains the one open unknown; empirically non-binding at current daily volume.

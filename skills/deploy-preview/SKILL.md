---
name: deploy-preview
description: "Cron-scheduled probe. Scans open issues with non-null pr_url, finds deploy preview URLs (Vercel/Netlify/Cloudflare Pages/GitHub Pages) in PR body+comments, emits deploy_preview events on the ledger so dev-quest's FOCUS pane can show a 'Preview ready' badge."
---

# deploy-preview — Preview-URL Probe

Per ADR 0007, dev-quest's FOCUS pane wants to show a "Preview ready" badge for issues whose PR has a live deploy. We don't want to spawn a daemon for this — instead, this skill runs on a cron and probes GitHub for preview URLs.

## When to use

- Cron-scheduled, every ~5 minutes.
- One-shot: lists candidate issues, probes each, emits events, exits.
- Re-runnable: skips issues that already have a successful `deploy_preview` event.

## Contract

```
bun ~/repos/arc/packages/arc-agents/bin/deploy-preview.ts [--db <path>] [--limit N] [--dry] [--once]
```

Inputs (all optional):

| Flag | Default | Notes |
|---|---|---|
| `--db` | `~/vault/ledger.db` | path to ledger sqlite |
| `--limit` | `20` | max candidates per run |
| `--dry` | off | log what would be emitted but don't write |
| `--once` | (no-op) | reserved; the script is already one-shot |

Output: one JSON line per run.

```json
{"candidates":3,"emitted":2,"dry":false}
```

In `--dry` mode, also logs one JSON line per candidate:

```json
{"id":"feat-quest-pane-a1b2","would_emit":"provider: vercel\nurl: https://feature.vercel.app"}
```

## Candidate selection

A row is a candidate iff:

- `issues.pr_url IS NOT NULL`
- `issues.state NOT IN ('merged','cancelled')` — terminal rows are skipped (the preview is moot once merged, and we never want to keep probing dead PRs).
- No prior `issue_events` row exists where `kind='deploy_preview'` AND `payload_md LIKE 'provider:%'`. The `provider:%` filter is what distinguishes a successful probe from a skip — skips are written with `skip:` prefix and remain candidates next run.

Ordered by `updated_at DESC`, capped at `--limit`.

## Probe order

For each candidate PR URL parsed as `https://github.com/<owner>/<repo>/pull/<n>`:

1. `GET /repos/<owner>/<repo>/pulls/<n>` — PR body
2. `GET /repos/<owner>/<repo>/issues/<n>/comments` — bot/issue comments
3. `GET /repos/<owner>/<repo>/pulls/<n>/comments` — PR review comments

First URL in any of those bodies whose host matches a known preview provider wins. Recognized hosts:

- `*.vercel.app` → `vercel`
- `*.netlify.app` / `*.netlify.com` → `netlify`
- `*.pages.dev` → `cloudflare-pages`
- `*.github.io` → `github-pages`

Probing stops on the first match per PR.

## Auth

GitHub token resolution:

1. `$GITHUB_TOKEN` env var
2. `pass show github/api-token`
3. Unauthenticated (public PRs only, 60 req/hr).

`401`/`403` responses cause the probe to bail for that PR with `skip_reason` recorded.

## Event emitted

```sql
INSERT INTO issue_events (issue_id, kind, agent, payload_md)
VALUES (?, 'deploy_preview', 'deploy-preview', ?)
```

Payload format (machine-readable):

```
provider: vercel
url: https://feature-branch.vercel.app
```

This is consumed by dev-quest's FOCUS pane (badge) and ACTIVITY pane (one-line item).

## Cron suggestion

```
*/5 * * * * cd ~/repos/arc/packages/arc-agents && bun bin/deploy-preview.ts >> ~/logs/deploy-preview.log 2>&1
```

## Sole-writer note

Per ADR 0002, bookie is the only writer of issue rows. `deploy_preview` is one of two events explicitly allowed to be written by non-bookie agents (the other is `afk_toggled`, written by dev-quest). Both are listed in migration 016's event_kind CHECK allowlist.

## Module

Pure logic lives at `src/ledger/deploy-preview.ts`:

- `parsePrUrl(url)` — extract owner/repo/number
- `classifyPreviewHost(url)` — provider lookup by hostname
- `extractPreviewUrl(markdown)` — find first provider URL in prose
- `probePreview(pr_url, { fetchFn, token })` — single-PR probe
- `probeBatch(candidates, { fetchFn, token })` — sequential batch
- `formatEventPayload(result)` — payload markdown

The CLI shell is the I/O layer; the module is the decision.

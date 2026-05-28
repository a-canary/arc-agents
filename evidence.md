# Evidence: human-visit-tailscale-funnel-url-and-ena

## Current State (2026-05-28)
- `tailscale funnel status` → `{}` — no funnel config active
- `tailscale serve status` → `No serve config`
- home-lab-1 is reachable via tailnet (home-lab-1.tail621e8f.ts.net.)
- Funnel enablement requires the Tailscale operator to visit:
  https://login.tailscale.com/f/funnel?node=n9tNgNB42X11CNTRL

## Why This Is HITL-Only
Tailscale Funnel must be enabled via the Tailscale admin console web UI.
No CLI flag or API call can bypass the admin console flow.

## Required Human Action
1. Visit https://login.tailscale.com/f/funnel?node=n9tNgNB42X11CNTRL
2. Log in as Tailscale operator account (check ~/vault/secrets/tailscale-operator.md or passbolt)
3. Click "Enable Funnel" on node home-lab-1 (node key: n9tNgNB42X11CNTRL)
4. Verify: `tailscale funnel status` on home-lab-1 should show `{"Ready": true}`

## Acceptance Criteria
- `tailscale funnel status` shows funnel enabled (non-empty JSON, Ready: true)
- `curl https://home-lab-1.<tailnet>` returns HTTPS from the node
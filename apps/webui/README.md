# arc-webui

SvelteKit shell for the 2-panel HITL+AFK rewrite (see `PRD-arc-webui.md`,
`SLICE-PLAN-arc-webui.md`). This package is the S6 shell deliverable —
scaffolding only. AFK Sugiyama layout (d3-dag), thread overlay, and
artifact gallery land in follow-up slices.

## Layout

- `src/routes/+layout.svelte` — top bar + HITL/AFK tab switch
- `src/routes/HitlPanel.svelte` — placeholder list of HITL threads
- `src/routes/AfkPanel.svelte` — three-lane placeholder (completed / in-flight / pending)
- `src/lib/sse.ts` — SSE client store; one-store-per-endpoint
- `src/lib/stores.ts` — wires `/sse/hitl` and `/sse/afk`
- `src/lib/types.ts` — IssueRow + SseEvent contract (matches PRD)

## Dev

```sh
cd apps/webui
bun install
bun run dev
```

Vite proxies `/sse/*` to `http://127.0.0.1:8787` (the S2 webui-server). When
the server is absent the panels show `connecting…` and remain empty —
expected pre-S2.

## Build

```sh
bun run build      # outputs to build/ via adapter-node
bun run check      # svelte-check
```

## Auth + bind

Auth + tailscale0 bind happens in the SSE server (S2 / S10). The shell is
unaware; it only consumes SSE relative to its origin.

# Evidence: obtain-ssh-access-to-home-lab-1-aggn

## Root Cause
`~/.ssh/config` had `HostName 127.0.1.1` (localhost) for `home-lab-1`. The Tailscale magic DNS name resolves to `100.91.151.13` on the local machine, but `127.0.1.1` pointed elsewhere (possibly a stale Tailscale loopback that no longer exists).

## Fix Applied
Changed `~/.ssh/config` Host entry for `home-lab-1`:
- FROM: `HostName 127.0.1.1`
- TO:   `HostName 100.91.151.13`

## Verification
```
$ ssh home-lab-1 'echo OK && hostname && uptime'
OK
home-lab-1
16:06:30 up 24 days, 15:33, 4 users, load average: 3.69, 8.11, 7.05
```

SSH key auth works. home-lab-1 is up (24-day uptime), repo at `~/repos/onenation-minimax` exists, Docker v29.3.1 present, Node v25.1.0 present, pnpm v10.32.1 present. pm2 and cloudflared not yet on PATH or not installed — note for deploy-runbook child.

## PR
No code change in arc-agents worktree. The fix is a one-liner in `~/.ssh/config` (user dotfile, not in git). No separate PR needed.

## State of home-lab-1
- Hostname: home-lab-1
- Tailscale IP: 100.91.151.13
- Distro: Ubuntu (up 24 days)
- Repo: ~/repos/onenation-minimax — exists
- Docker: 29.3.1 ✓
- Node: v25.1.0 ✓
- pnpm: 10.32.1 ✓
- pm2: not found on PATH (may need install)
- cloudflared: not found on PATH (may need install)
- Caddy: not found on PATH (may need install)
- Disk: 226G total, 160G used, 55G avail (75%)

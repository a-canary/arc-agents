# systemd units

User-level systemd unit files for arc-agents daemons. Install with:

```
cp systemd/arc-factory.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now arc-factory.service
```

To pick up changes after editing a unit:

```
cp systemd/arc-factory.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user restart arc-factory.service
```

## arc-factory.service

Supervises `bin/factory.ts`. Restarts on **any** exit because the factory has
no legitimate reason to stop while the user is logged in. On 2026-05-17 the
prior `Restart=on-failure` unit went inactive after a clean exit and stayed
dead for two days — the stale-claim sweeper stopped, zombie claims piled up,
and ready tasks went unspawned. `Restart=always` + `StartLimitBurst=0`
eliminates that failure mode.

Logs: `~/.cache/arc-factory.log`.

## arc-factory.logrotate

Daily rotation for the factory log (7 generations, 10M size cap, gzip with
1-day delay). The systemd unit opens the log with `StandardOutput=append:`,
so `copytruncate` is used — no SIGHUP path exists to make it reopen the
file. Install once as root:

```
sudo cp systemd/arc-factory.logrotate /etc/logrotate.d/arc-factory
```

The system `/etc/cron.daily/logrotate` job picks it up automatically.

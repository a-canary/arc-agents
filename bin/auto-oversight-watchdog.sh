#!/usr/bin/env bash
# auto-oversight watchdog. The oversight skill rotates mission state BEFORE
# working, so a dead/timed-out run silently skips a mission and only cron.log
# knows. This observes the ledger after each 2h cron slot: no auto-oversight
# feedback row in the lookback window -> insert one deduped alert row so the
# gap is webui-visible. Observation only; launches nothing.
set -uo pipefail
LOOKBACK_MIN="${LOOKBACK_MIN:-130}"
command -v bun >/dev/null 2>&1 || exit 0
HOUR_ID="ao-watchdog-$(date -u +%Y%m%d%H)" LOOKBACK_MIN="$LOOKBACK_MIN" bun -e '
  const {Database}=require("bun:sqlite");
  const d=new Database(process.env.HOME+"/vault/ledger.db");
  const cutoff=new Date(Date.now()-Number(process.env.LOOKBACK_MIN)*60*1000).toISOString();
  const n=d.query("select count(*) c from feedback where source=\"auto-oversight\" and id like \"ao-%\" and created_at>=?").get(cutoff).c;
  if(n===0){
    d.query("insert or ignore into feedback (id,project,source,submitter,body_md,state,created_at) values (?,?,?,?,?,?,?)")
     .run(process.env.HOUR_ID,"allmissions","auto-oversight","ao-watchdog",
          "**auto-oversight gap** — no audit row in last "+process.env.LOOKBACK_MIN+" min; the 2h cron likely died/timed out and its mission slot was consumed unaudited. See ~/vault/oversight/cron.log",
          "OPEN",new Date().toISOString());
    console.log("ALERT inserted");
  } else { console.log("ok rows="+n); }' 2>/dev/null || true

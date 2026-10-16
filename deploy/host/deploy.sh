#!/bin/bash
# WO-TWIN-01 idempotent re-deploy for the OpenDots host. Run from a checkout of this directory.
# Installs the canonical files to their host locations and re-converges compose + cron.
# Safe to run repeatedly: no rebuilds (the guard reuses the running app image), env/secrets
# are never overwritten, compose up -d only recreates what changed.
set -eu
log(){ echo "[$(date '+%H:%M:%S')] $*"; }
OD=/mnt/genius_vol_2/opendots
[ -f $OD/.env ] || { echo "FATAL: $OD/.env missing (first boot needs install.sh, not deploy.sh)"; exit 1; }
D=$(cd "$(dirname "$0")" && pwd)
W="nice -n15 ionice -c3 timeout"
# 1. canonical files -> host locations (only if content differs; secrets never touched)
install -m 644 $D/compose.host.yml $OD/compose.host.yml
install -m 644 $D/tailnet-guard.mjs $OD/tailnet-guard.mjs
install -m 700 $D/backup-r2.sh /root/bin/opendots-backup-r2.sh
install -m 700 $D/health.sh /root/bin/opendots-health.sh
install -m 700 $D/cap-guard.sh /root/bin/opendots-cap-guard.sh
install -m 700 $D/seat-sync.py /root/bin/opendots-seat-sync.py
chmod 600 $OD/.env
# 2. converge containers (recreates only services whose config changed)
cd $OD && $W 300 docker compose -f compose.host.yml --env-file .env up -d 2>&1 | tail -5
# 3. cron: cap-guard every minute, seat sync 4x/h, backup nightly 03:23, health every 15 min
( crontab -l 2>/dev/null | rg -v 'opendots-cap-guard|opendots-seat-sync|opendots-backup-r2|opendots-health'
  echo "* * * * * /root/bin/opendots-cap-guard.sh >> /var/log/opendots-cap-guard.log 2>&1  # oppi 2026-10-16"
  echo "7,22,37,52 * * * * nice -n15 ionice -c3 timeout 600 python3 /root/bin/opendots-seat-sync.py >> /var/log/opendots-seat-sync.log 2>&1  # oppi 2026-10-16"
  echo "23 3 * * * nice -n15 ionice -c3 timeout 1800 /root/bin/opendots-backup-r2.sh >> /var/log/opendots-backup.log 2>&1  # WO-TWIN-01"
  echo "11,26,41,56 * * * * /root/bin/opendots-health.sh >> /var/log/opendots-health.log 2>&1  # WO-TWIN-01" ) | crontab -
log "cron: $(crontab -l | rg -c 'opendots-') opendots lines"
log "DEPLOY-DONE (idempotent; re-run any time)"

#!/bin/bash
# WO-TWIN-01 health check: app /api/state (bearer via curl config file, never argv),
# supervisor container health, cap-guard freshness. Prints HEALTH lines, exits non-zero on failure.
set -u
OD=/mnt/genius_vol_2/opendots
FAIL=0
T=$(grep ^OWNER_TOKEN= $OD/.env | cut -d= -f2-)
umask 077; C=$(mktemp); printf 'header = "Authorization: Bearer %s"\n' "$T" > "$C"; unset T
CODE=$(curl -s -o /tmp/od-health-state.json -w '%{http_code}' -m 10 -K "$C" http://127.0.0.1:4320/api/state)
rm -f "$C"
if [ "$CODE" = 200 ]; then S=ok; else S=fail; FAIL=1; fi
echo "HEALTH app-api-state http=$CODE status=$S"
rm -f /tmp/od-health-state.json
SUP=$(docker exec opendots-host-computer-supervisor-1 node -e "fetch('http://127.0.0.1:4300/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null && echo healthy || echo fail)
[ "$SUP" = healthy ] || FAIL=1
echo "HEALTH supervisor status=$SUP (liveness-only /health exec probe)"
if [ -f /var/log/opendots-cap-guard.log ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y /var/log/opendots-cap-guard.log) ))
  if [ $AGE -le 300 ]; then CG=ok; else CG=stale; FAIL=1; fi
  RUNNING=$(docker ps --filter name=odhost-computer- --format '{{.Names}}' | wc -l)
  CAPPED=$(docker ps --filter name=odhost-computer- --format '{{.Names}}' | xargs -r docker inspect -f '{{.HostConfig.NanoCpus}}' | rg -c 500000000 || true)
  echo "HEALTH cap-guard status=$CG age=${AGE}s running=$RUNNING capped-at-0.5cpu=$CAPPED"
else
  echo "HEALTH cap-guard status=missing"; FAIL=1
fi
GUARD=$(docker inspect -f '{{.State.Health.Status}}' opendots-host-tailnet-guard-1 2>/dev/null)
echo "HEALTH tailnet-guard status=${GUARD:-absent}"
[ "$GUARD" = healthy ] || FAIL=1
echo "HEALTH SUMMARY overall=$([ $FAIL = 0 ] && echo ok || echo degraded) load=$(cut -d' ' -f1-3 /proc/loadavg) mem_avail=$(free -m | awk '/Mem:/{print $7}')M"
exit $FAIL

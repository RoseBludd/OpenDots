#!/bin/bash
# opendots-cap-guard (oppi., 2026-10-16): keep host OpenDots desks inside caps so live products are never starved.
# Every minute: give each odhost computer 0.5 CPU / 1G; if more than MAX running, stop the oldest-started extras.
MAX=${OPENDOTS_MAX_RUNNING:-2}
for c in $(docker ps --filter name=odhost-computer- --format '{{.Names}}'); do
  [ "$(docker inspect -f '{{.HostConfig.NanoCpus}}' $c)" = "500000000" ] || docker update --cpus 0.5 --memory 1g --memory-swap 1536m $c >/dev/null
done
mapfile -t RUN < <(docker ps --filter name=odhost-computer- --format '{{.Names}}' | xargs -r docker inspect -f '{{.State.StartedAt}} {{.Name}}' | sort | awk '{print $2}' | tr -d /)
n=${#RUN[@]}; i=0
while [ $n -gt $MAX ]; do docker stop -t 20 ${RUN[$i]} >/dev/null && echo "$(date -Is) cap-guard stopped ${RUN[$i]} (running>$MAX)"; i=$((i+1)); n=$((n-1)); done
# One owner per desk: stop any host computer whose desk OWNER is not "host" (map in desk-map.tsv: dotId<TAB>desk)
M=/mnt/genius_vol_2/opendots/desk-map.tsv; H=/mnt/genius_vol_2/opendots/handoff/seats
[ -f $M ] && for c in $(docker ps --filter name=odhost-computer- --format '{{.Names}}'); do
  id=${c#odhost-computer-}; d=$(awk -F'\t' -v i="$id" '$1==i{print $2}' $M)
  [ -n "$d" ] && [ "$(head -c 5 $H/$d/OWNER 2>/dev/null)" != "host" ] && docker stop -t 20 $c >/dev/null && echo "$(date -Is) cap-guard stopped $c ($d is not host-owned)"
done
echo "$(date -Is) ok running=${#RUN[@]} max=$MAX" # heartbeat so the health script can see liveness
exit 0

#!/bin/bash
# OpenDots host install (oppi., 2026-10-16). Log: /var/log/oppi-opendots-install.log
set -u
log(){ echo "[$(date '+%H:%M:%S')] $*"; }
W="nice -n15 ionice -c3 timeout"
OD=/mnt/genius_vol_2/opendots; S=/root/oppi-exec; mkdir -p $OD/desks $OD/handoff/seats $OD/handoff/progress $OD/images; chmod 750 $OD
snap(){ log "SNAP $1: load=$(cut -d' ' -f1-3 /proc/loadavg) mem_avail=$(free -m | awk '/Mem:/{print $7}')M swap_used=$(free -m | awk '/Swap:/{print $3}')M containerd_avail=$(df -BM --output=avail /var/lib/containerd | tail -1) vol2_avail=$(df -BM --output=avail /mnt/genius_vol_2 | tail -1)"; }
snap start
# 1. images (built on TRILL, transferred; no builds on the host)
for f in $S/img/*.tar.gz; do log "load $(basename $f)"; gunzip -c $f | $W 1200 docker load | tail -1; done
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | rg 'opendots-(app|supervisor|computer)'
cp $S/img/opendots-trill-local.patch $OD/ 2>/dev/null
# 2. files
install -m 644 $S/od/compose.host.yml $OD/compose.host.yml
install -m 644 $S/od/ROUTING.md $OD/handoff/ROUTING.md
install -m 700 $S/od/cap-guard.sh /root/bin/opendots-cap-guard.sh
install -m 700 $S/od/seat-sync.py /root/bin/opendots-seat-sync.py
cp $S/desk-dots.json $OD/desk-dots.json
python3 - <<'P'
import json
d=json.load(open('/mnt/genius_vol_2/opendots/desk-dots.json'))
with open('/mnt/genius_vol_2/opendots/desk-map.tsv','w') as f:
    for x in d['dots']: f.write(f"{x['id']}\t{x['name'].split('.')[0]}\n")
P
cat $OD/desk-map.tsv | tr '\n' ' '; echo
# 3. seats from R2 handoff/seats + progress (skip junk), then ownership locks
log "seat pull start"; $W 1800 nice -n15 python3 /root/bin/opendots-seat-sync.py --initial 2>&1 | tail -3
HOSTDESKS="devvy oppi sec pulse prospy vertzy"
for d in $(cut -f2 $OD/desk-map.tsv); do
  mkdir -p $OD/handoff/seats/$d $OD/desks/$d
  o=trill; case " $HOSTDESKS " in *" $d "*) o=host;; esac
  printf '%s\nsince=2026-10-16 by=oppi. rule=handoff/ROUTING.md\n' $o > $OD/handoff/seats/$d/OWNER
  cp $OD/handoff/ROUTING.md $OD/handoff/seats/$d/ROUTING.md
  printf '# %s. desk workspace on the host (scratch). Seat memory: /workspace/genius/genius-handoff/seats/%s/\n' $d $d > $OD/desks/$d/README.md
done
chown -R 1000:1000 $OD/desks $OD/handoff   # computer user (uid 1000) must write seats/progress
du -sh $OD/handoff/seats $OD/desks; find $OD/handoff/seats -type f | wc -l
# push locks + ROUTING to R2 (shared with TRILL)
python3 - <<'P'
import os,boto3
env={}
for l in open('/opt/agent-twins/.env'):
    l=l.strip()
    if '=' in l and not l.startswith('#'): k,v=l.split('=',1); env[k]=v.strip().strip('"').strip("'")
s3=boto3.client('s3',region_name='auto',endpoint_url=env['R2_ENDPOINT'],aws_access_key_id=env['R2_ACCESS_KEY_ID'],aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
R='/mnt/genius_vol_2/opendots/handoff'; n=0
s3.upload_file(R+'/ROUTING.md',env['R2_BUCKET'],'handoff/ROUTING.md'); n+=1
for d in os.listdir(R+'/seats'):
    for f in ('OWNER','ROUTING.md'):
        p=f'{R}/seats/{d}/{f}'
        if os.path.exists(p): s3.upload_file(p,env['R2_BUCKET'],f'handoff/seats/{d}/{f}'); n+=1
print('r2 pushed',n,'routing/owner files')
P
# 4. env (0600): generated tokens; CADIS + Intelligence keys left EMPTY (blocked: no dedicated key; shared prod key 251b5739 must not be reused)
E=$OD/.env
if [ ! -f $E ]; then umask 077; {
  echo "OWNER_TOKEN=$(openssl rand -hex 24)"; echo "OWNER_ID=opendots-owner"; echo "APP_ORIGIN=http://127.0.0.1:4320"
  echo "COMPUTER_SUPERVISOR_TOKEN=$(openssl rand -hex 24)"; echo "SUPERVISOR_TOKEN_PLACEHOLDER=see-below"; echo "COMPUTER_TOKEN=$(openssl rand -hex 24)"
  echo "DOT_RUN_BUDGET_MS=1800000"; echo "TASK_TIMEOUT_MS=1860000"; echo "OPENAI_API_KEY="; echo "INTELLIGENCE_API_KEY="; echo "INTELLIGENCE_API_URL="; echo "PARALLEL_API_KEY="
} > $E; sed -i '/SUPERVISOR_TOKEN_PLACEHOLDER/d' $E; echo "SUPERVISOR_TOKEN=$(grep ^COMPUTER_SUPERVISOR_TOKEN= $E | cut -d= -f2-)" >> $E; umask 022; fi
B=""; while IFS=$'\t' read -r id d; do B="$B|$id=$OD/desks/$d:/workspace/genius/desk:rw"; done < $OD/desk-map.tsv
B="$OD/handoff:/workspace/genius/genius-handoff:rw$B"
grep -q '^COMPUTER_EXTRA_BINDS=' $E && sed -i '/^COMPUTER_EXTRA_BINDS=/d' $E; echo "COMPUTER_EXTRA_BINDS=$B" >> $E
chmod 600 $E; log "env names: $(cut -d= -f1 $E | tr '\n' ' ')"
# 5. start (app + supervisor), initialise DB
cd $OD && $W 300 docker compose -f compose.host.yml --env-file .env up -d 2>&1 | tail -5
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:4320/ | rg -q '200|302|401' && break; sleep 4; done
log "app http=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:4320/) supervisor=$(docker inspect -f '{{.State.Health.Status}}' opendots-host-computer-supervisor-1 2>/dev/null)"
docker compose -f compose.host.yml logs --tail 15 app 2>&1 | sed -E 's/[A-Za-z0-9_-]{32,}/<R>/g'
snap after-start
log INSTALL-STAGE1-DONE

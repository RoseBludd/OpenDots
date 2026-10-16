#!/bin/bash
# Stage 2: import 15 desk Dots, cron jobs, shell-level desk checks. Log appended to /var/log/oppi-opendots-install.log
set -u
log(){ echo "[$(date '+%H:%M:%S')] $*"; }
OD=/mnt/genius_vol_2/opendots; cd $OD
V=$(docker volume inspect opendots-host_opendots-data --format '{{.Mountpoint}}')
log "data volume: $V ($(df -h --output=target $V | tail -1))"
docker compose -f compose.host.yml --env-file .env stop app >/dev/null 2>&1
python3 - "$V/opendots.sqlite" <<'P'
import sqlite3,json,sys
db=sqlite3.connect(sys.argv[1]); d=json.load(open('/mnt/genius_vol_2/opendots/desk-dots.json'))
host={'devvy','oppi','sec','pulse','prospy','vertzy'}
tabs={r[0] for r in db.execute("select name from sqlite_master where type='table'")}
print('tables',sorted(tabs))
def ins(t,row):
    cols=[c[1] for c in db.execute(f'pragma table_info("{t}")')]
    row={k:v for k,v in row.items() if k in cols}
    db.execute(f'insert or replace into "{t}" ({",".join(row)}) values ({",".join("?"*len(row))})',list(row.values()))
for s in d['spaces']: ins('spaces',s)
for x in d['dots']: ins('dots',x)
for x in d['dot_spaces']: ins('dot_spaces',x)
names={x['id']:x['name'].split('.')[0] for x in d['dots']}
for x in d['computer_permissions']:
    v=json.loads(x['value'])
    if names[x['dotId']] not in host: v['enabled']=False   # one owner per desk: TRILL-owned desks cannot run here
    ins('computer_permissions',{'dotId':x['dotId'],'value':json.dumps(v)})
# Part C (RECON-2026-10-16): six spaces = companies/products; default space per desk + Genius HQ publish rights
import uuid,time
SP=['Genius HQ','Rooferzs & Verticals','blockzs/Genius OS','Callerzs/Emailzs','GTM Pipeline','Infra & Security']
have={r[1]:r[0] for r in db.execute('select id,name from spaces')}
now=int(time.time()*1000)
for n in SP:
    if n not in have:
        i=str(uuid.uuid5(uuid.NAMESPACE_URL,'opendots-host/'+n)); ins('spaces',{'id':i,'name':n,'description':'Part C layout (oppi. 2026-10-16)','createdAt':now}); have[n]=i
MAIN={'genius':'Genius HQ','archy':'Genius HQ','devvy':'blockzs/Genius OS','launchy':'blockzs/Genius OS','vertzy':'Rooferzs & Verticals','towy':'Rooferzs & Verticals',
 'oppi':'Infra & Security','sec':'Infra & Security','prospy':'GTM Pipeline','pulse':'GTM Pipeline','permy':'GTM Pipeline','flippy':'GTM Pipeline','agenzy':'GTM Pipeline','seo':'GTM Pipeline','simmy':'GTM Pipeline'}
for x in d['dots']:
    n=names[x['id']]; m=have[MAIN[n]]
    db.execute('update dots set spaceId=? where id=?',(m,x['id']))
    for s_ in {m,have['Genius HQ']}: db.execute('insert or ignore into dot_spaces (dotId,spaceId) values (?,?)',(x['id'],s_))
db.commit()
print('spaces',[r[0] for r in db.execute('select name from spaces')])
print('dots',db.execute('select count(*) from dots').fetchone()[0],'enabled_perms',db.execute("select count(*) from computer_permissions where value like '%\"enabled\": true%' or value like '%\"enabled\":true%'").fetchone()[0])
P
chown 1000:1000 $V/opendots.sqlite* 2>/dev/null
docker compose -f compose.host.yml --env-file .env up -d app 2>&1 | tail -2; sleep 8
T=$(grep ^OWNER_TOKEN= .env | cut -d= -f2-)
log "app /api/state: $(curl -s -o /tmp/od-state.json -w '%{http_code}' -m 10 -K <(printf 'header = "Authorization: Bearer %s"\n' "$T") http://127.0.0.1:4320/api/state) unauth=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:4320/api/state)"; unset T
python3 -c "import json;j=json.load(open('/tmp/od-state.json'));print('state keys',list(j)[:12])" 2>&1 | head -2; rm -f /tmp/od-state.json
# Part C memory: global Memories = standing rules only (injected into every Dot)
T=$(grep ^OWNER_TOKEN= .env | cut -d= -f2-)
grep -E '^[0-9]+\. ' /root/oppi-twins/standing-rules.md | head -12 | while IFS= read -r line; do
  python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1][:1000]}))' "$line" | curl -s -o /dev/null -w '%{http_code} ' -m 10 -K <(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$T") -X POST --data-binary @- http://127.0.0.1:4320/api/memories
done; echo; unset T
log "memories: $(python3 -c "import sqlite3;print(sqlite3.connect('$V/opendots.sqlite').execute('select count(*) from memories').fetchone()[0])")"
log "run-cap env in app: $(docker exec opendots-host-app-1 sh -c 'echo TASK_TIMEOUT_MS=$TASK_TIMEOUT_MS DOT_RUN_BUDGET_MS=$DOT_RUN_BUDGET_MS')"
log "run-cap code in image: $(docker exec opendots-host-app-1 sh -c 'grep -rhoE "process\.env\.(TASK_TIMEOUT_MS|DOT_RUN_BUDGET_MS)" /app/dist | sort | uniq -c | tr "\n" " "')"
log "supervisor: $(docker inspect -f '{{.State.Health.Status}}' opendots-host-computer-supervisor-1)"
# cron: cap guard every minute, seat sync every 15 min
( crontab -l 2>/dev/null | rg -v 'opendots-cap-guard|opendots-seat-sync'; echo "* * * * * /root/bin/opendots-cap-guard.sh >> /var/log/opendots-cap-guard.log 2>&1  # oppi 2026-10-16"; echo "7,22,37,52 * * * * nice -n15 ionice -c3 timeout 600 python3 /root/bin/opendots-seat-sync.py >> /var/log/opendots-seat-sync.log 2>&1  # oppi 2026-10-16" ) | crontab -
log "cron: $(crontab -l | rg -c 'opendots-(cap-guard|seat-sync)') opendots lines"
# shell-level desk checks: same computer image, caps and mounts the supervisor uses; no model, no network
for d in devvy oppi sec pulse prospy vertzy; do
  r=$(timeout 120 docker run --rm --name odhost-deskcheck-$d --network none --cpus 0.5 --memory 1g --user 1000:1000 \
    -v $OD/handoff:/workspace/genius/genius-handoff:rw -v $OD/desks/$d:/workspace/genius/desk:rw \
    --entrypoint sh opendots-computer:b6932d3-dev -c "echo uid=\$(id -u); test -r /workspace/genius/genius-handoff/seats/$d/BRIEF.md && echo brief=ok || echo brief=MISSING; echo owner=\$(head -1 /workspace/genius/genius-handoff/seats/$d/OWNER); date -Is > /workspace/genius/desk/.desk-check && echo desk-write=ok; echo progress-write=\$(touch /workspace/genius/genius-handoff/progress/.check-$d && echo ok && rm /workspace/genius/genius-handoff/progress/.check-$d); git --version | cut -c1-20; echo DESK-OK-$d" 2>&1 | tr '\n' ' ')
  log "deskcheck $d: $r"
done
log "load=$(cut -d' ' -f1-3 /proc/loadavg) mem_avail=$(free -m | awk '/Mem:/{print $7}')M swap_used=$(free -m | awk '/Swap:/{print $3}')M"
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' | rg opendots-host
install -o 1000 -g 1000 -m 644 /root/oppi-exec/od/QUEUE-opendots-integrations.md $OD/handoff/seats/devvy/QUEUE-opendots-integrations.md && log "devvy queue written (5 tasks)"
nice -n15 timeout 600 python3 /root/bin/opendots-seat-sync.py 2>&1 | tail -1
log STAGE2-DONE

import sqlite3, re, uuid, datetime, os, sys
DB='/mnt/genius_vol_1/docker/volumes/opendots-host_opendots-data/_data/opendots.sqlite'
SEATS='/mnt/genius_vol_2/opendots/handoff/seats'
con=sqlite3.connect(DB, timeout=30); con.execute('pragma busy_timeout=30000')
dots={n.replace('. (desk)',''):i for i,n in con.execute("select id,name from dots where name like '%. (desk)'")}
hdr=re.compile(r'^### (user|assistant) · (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) CT\s*$', re.M)
NS=uuid.UUID('6f1c0a52-0000-4000-8000-5ea7415701ff')
tot=0
for seat,did in sorted(dots.items()):
    p=f'{SEATS}/{seat}/transcript.md'
    if not os.path.exists(p): print(seat,'no transcript'); continue
    txt=open(p).read(); ms=list(hdr.finditer(txt)); msgs=[]
    for i,m in enumerate(ms):
        body=txt[m.end(): ms[i+1].start() if i+1<len(ms) else len(txt)].strip()
        y,mo,d,h,mi=map(int,m.groups()[1:])
        off=5 if (mo,d)<(11,1) and (mo,d)>=(3,9) else 6
        ts=int(datetime.datetime(y,mo,d,h,mi,tzinfo=datetime.timezone.utc).timestamp()*1000)+off*3600000
        msgs.append((m.group(1),body,ts))
    if not msgs:
        body=txt.split('\n',1)[1].strip() if txt.startswith('#') else txt.strip()
        msgs=[('assistant',body,1792108800000)]
    tid=str(uuid.uuid5(NS,seat))
    con.execute('delete from direct_messages where threadId=?',(tid,)); con.execute('delete from thread_bindings where id=?',(tid,))
    con.execute('insert into thread_bindings(id,dotId,ownerId,title,createdAt) values(?,?,?,?,?)',(tid,did,'opendots-owner',f'{seat}. — Grok Bot history (imported)',msgs[0][2]))
    last=0
    for k,(r,b,ts) in enumerate(msgs):
        ts=max(ts,last+1); last=ts
        con.execute('insert into direct_messages(id,threadId,role,content,model,createdAt) values(?,?,?,?,?,?)',(str(uuid.uuid5(NS,f'{seat}:{k}')),tid,r,b,None,ts))
    tot+=len(msgs); print(seat,len(msgs))
con.commit(); print('total',tot)

import sqlite3, re, uuid, datetime, os, sys
DB='/mnt/genius_vol_1/docker/volumes/opendots-host_opendots-data/_data/opendots.sqlite'
SEATS='/mnt/genius_vol_2/opendots/handoff/seats'
con=sqlite3.connect(DB, timeout=30); con.execute('pragma busy_timeout=30000')
dots={n.replace(' (desk)','').rstrip('.'):i for i,n in con.execute("select id,name from dots where name like '%.' or name like '%. (desk)'")}
hdr=re.compile(r'^### (user|assistant|send) · (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) CT((?: [←→] [\w.]+)*)\s*$', re.M)
NS=uuid.UUID('6f1c0a52-0000-4000-8000-5ea7415701ff')
tot=0
for seat,did in sorted(dots.items()):
    p=f'{SEATS}/{seat}/transcript.md'
    if not os.path.exists(p): print(seat,'no transcript'); continue
    txt=open(p).read(); ms=list(hdr.finditer(txt)); msgs=[]
    for i,m in enumerate(ms):
        body=txt[m.end(): ms[i+1].start() if i+1<len(ms) else len(txt)].strip()
        y,mo,d,h,mi=map(int,m.groups()[1:6]); tag=m.group(7).strip()
        off=5 if (mo,d)<(11,1) and (mo,d)>=(3,9) else 6
        ts=int(datetime.datetime(y,mo,d,h,mi,tzinfo=datetime.timezone.utc).timestamp()*1000)+off*3600000
        role='user' if m.group(1)=='user' else 'assistant'
        if tag: body=f'*{tag}*\n\n'+body
        msgs.append((role,body,ts))
    title=f'{seat}. — Grok Bot history'
    if not msgs:
        title=f'{seat}. — handoff brief and work log'
        for label,fn in (('Brief','BRIEF.md'),('Current state','STATE.md'),('Work log','log.md')):
            fp=f'{SEATS}/{seat}/{fn}'
            if os.path.exists(fp) and os.path.getsize(fp)>0:
                body=re.sub(r'^# .*\n+','',open(fp).read(),count=1).strip()
                msgs.append(('assistant',f'**{label}**\n\n{body}',int(os.path.getmtime(fp)*1000)))
        if not msgs: print(seat,'nothing to import'); continue
        msgs.sort(key=lambda m:m[2])
    tid=str(uuid.uuid5(NS,seat))
    con.execute('delete from direct_messages where threadId=?',(tid,)); con.execute('delete from thread_bindings where id=?',(tid,))
    con.execute('insert into thread_bindings(id,dotId,ownerId,title,createdAt) values(?,?,?,?,?)',(tid,did,'opendots-owner',title,msgs[0][2]))
    last=0
    for k,(r,b,ts) in enumerate(msgs):
        ts=max(ts,last+1); last=ts
        con.execute('insert into direct_messages(id,threadId,role,content,model,createdAt) values(?,?,?,?,?,?)',(str(uuid.uuid5(NS,f'{seat}:{k}')),tid,r,b,None,ts))
    tot+=len(msgs); print(seat,len(msgs))
con.commit(); print('total',tot)

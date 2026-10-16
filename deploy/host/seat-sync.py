#!/usr/bin/env python3
"""opendots-seat-sync (oppi., 2026-10-16). Shared seat folders between host OpenDots and TRILL via R2
genius-agent-twins handoff/seats/<desk>/ (+ handoff/progress/<desk>.md, ROUTING.md, APPROVALS.md).
One owner per desk: handoff/seats/<desk>/OWNER = host|trill. Host pushes ONLY desks it owns, pulls the rest.
Usage: opendots-seat-sync.py [--initial]   Creds: /opt/agent-twins/.env (never printed)."""
import os, sys, json, time, boto3
from concurrent.futures import ThreadPoolExecutor
from boto3.s3.transfer import TransferConfig
env={}
for l in open('/opt/agent-twins/.env'):
    l=l.strip()
    if '=' in l and not l.startswith('#'): k,v=l.split('=',1); env[k]=v.strip().strip('"').strip("'")
s3=boto3.client('s3',region_name='auto',endpoint_url=env['R2_ENDPOINT'],aws_access_key_id=env['R2_ACCESS_KEY_ID'],aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
B=env['R2_BUCKET']; ROOT='/mnt/genius_vol_2/opendots/handoff'; STATE=ROOT+'/.seat-sync-state.json'
JUNK=('.tmp','~','.swp','.DS_Store','Thumbs.db','desktop.ini')
def owner(d):
    p=f'{ROOT}/seats/{d}/OWNER'
    return open(p).read().split()[0].strip().lower() if os.path.exists(p) else 'trill'
def listing(prefix):
    out={}; pg=s3.get_paginator('list_objects_v2')
    for page in pg.paginate(Bucket=B,Prefix=prefix):
        for o in page.get('Contents',[]): out[o['Key']]=(o['Size'],o['LastModified'].timestamp())
    return out
def pull(items):
    def one(kv):
        k,(sz,lm)=kv; p=os.path.join(ROOT,k[len('handoff/'):])
        if os.path.exists(p) and os.path.getsize(p)==sz and os.path.getmtime(p)>=lm-2: return 0
        os.makedirs(os.path.dirname(p),exist_ok=True); s3.download_file(B,k,p+'.part'); os.replace(p+'.part',p); os.utime(p,(lm,lm)); return 1
    with ThreadPoolExecutor(8) as ex: return sum(ex.map(one,items))
def push(paths,state):
    n=0
    for p in paths:
        st=os.stat(p); key='handoff/'+os.path.relpath(p,ROOT); sig=[st.st_size,int(st.st_mtime)]
        if state.get(key)==sig or p.endswith(JUNK): continue
        s3.upload_file(p,B,key,Config=TransferConfig(multipart_threshold=64*1024*1024)); state[key]=sig; n+=1
    return n
state=json.load(open(STATE)) if os.path.exists(STATE) else {}
remote=listing('handoff/seats/'); remote.update(listing('handoff/progress/'))
for k in ('handoff/ROUTING.md','handoff/APPROVALS.md'):
    try: h=s3.head_object(Bucket=B,Key=k); remote[k]=(h['ContentLength'],h['LastModified'].timestamp())
    except Exception: pass
initial='--initial' in sys.argv
def desk_of(k):
    parts=k.split('/')
    if parts[1]=='seats' and len(parts)>3: return parts[2]
    if parts[1]=='progress' and len(parts)==3: return parts[2].rsplit('.',1)[0]
    return None
junk=[k for k in remote if k.endswith(JUNK)]
items=[(k,v) for k,v in remote.items() if k not in junk and (initial or owner(desk_of(k) or '')!='host' or desk_of(k) is None) and not k.endswith('/OWNER')]
pulled=pull(items)
if initial:
    for k,v in remote.items():
        if k.endswith('/OWNER') and not os.path.exists(os.path.join(ROOT,k[8:])): pull([(k,v)])
pushed=0
for d in sorted(os.listdir(f'{ROOT}/seats')) if os.path.isdir(f'{ROOT}/seats') else []:
    if owner(d)!='host' or initial: continue
    files=[os.path.join(r,f) for r,_,fs in os.walk(f'{ROOT}/seats/{d}') for f in fs]
    pg=f'{ROOT}/progress/{d}.md'
    pushed+=push(files+([pg] if os.path.exists(pg) else []),state)
json.dump(state,open(STATE,'w'))
print(time.strftime('%F %T'),f'remote={len(remote)} junk_skipped={len(junk)} pulled={pulled} pushed={pushed} host_owned={[d for d in os.listdir(ROOT+"/seats") if owner(d)=="host"] if os.path.isdir(ROOT+"/seats") else []}')

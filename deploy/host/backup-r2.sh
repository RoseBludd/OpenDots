#!/bin/bash
# WO-TWIN-01 nightly sqlite->R2 backup for the OpenDots host.
# 1) online sqlite .backup -> /tmp, gzip; 2) R2 put to genius-server-backups/opendots/<date>.sqlite.gz
#    with same-size HEAD verify (oppi-eco-r2.py convention, creds from /opt/agent-twins/.env, mode 600);
# 3) retention: keep 14 days, delete older objects ONLY after today's copy is verified;
# 4) restore test: download the uploaded object back from R2 into a temp dir, gunzip, open with
#    sqlite3 and print row counts. No secrets in argv; nothing is printed except sizes/counts.
set -eu
OD=/mnt/genius_vol_2/opendots
DB=$(docker volume inspect opendots-host_opendots-data --format '{{.Mountpoint}}')/opendots.sqlite
[ -f "$DB" ] || { echo "BACKUP FAIL: db missing $DB"; exit 1; }
DATE=$(date +%F)
KEY="opendots/$DATE.sqlite.gz"
T=/tmp/opendots-backup.$$; mkdir -m 700 "$T"
trap 'rm -rf "$T"' EXIT
nice -n15 ionice -c3 sqlite3 "$DB" ".backup $T/opendots.sqlite"
gzip -f "$T/opendots.sqlite"
LOCAL=$(stat -c%s "$T/opendots.sqlite.gz")
echo "BACKUP SNAPSHOT $KEY local=$LOCAL bytes"
export BACKUP_KEY=$KEY BACKUP_FILE=$T/opendots.sqlite.gz
python3 - <<'P'
import os, sys, time, boto3
from botocore.exceptions import ClientError
env = {}
for l in open('/opt/agent-twins/.env'):
    l = l.strip()
    if '=' in l and not l.startswith('#'):
        k, v = l.split('=', 1); env[k] = v.strip().strip('"').strip("'")
BUCKET = env.get('BACKUP_BUCKET', 'genius-server-backups')
s3 = boto3.client('s3', region_name='auto', endpoint_url=env['R2_ENDPOINT'],
                  aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
key, f = os.environ['BACKUP_KEY'], os.environ['BACKUP_FILE']
local = os.path.getsize(f)
s3.upload_file(f, BUCKET, key, ExtraArgs={'ContentType': 'application/octet-stream'})
remote = s3.head_object(Bucket=BUCKET, Key=key)['ContentLength']
ok = remote == local
print(f"R2PUT {'OK' if ok else 'MISMATCH'} {key} local={local} remote={remote} bucket={BUCKET}")
if not ok: sys.exit(1)
# retention: only after a newer verified copy exists (today's upload just verified)
now = time.time(); cut = now - 14 * 86400; deleted = 0
for o in s3.list_objects_v2(Bucket=BUCKET, Prefix='opendots/').get('Contents', []):
    if o['Key'] < 'opendots/20' or o['Key'] == key:
        continue
    d = o['Key'].split('/')[-1].split('.')[0]
    try: ts = time.mktime(time.strptime(d, '%Y-%m-%d'))
    except ValueError: continue
    if ts < cut:
        s3.delete_object(Bucket=BUCKET, Key=o['Key']); deleted += 1
        print(f"RETENTION deleted {o['Key']} (older than 14d)")
print(f"RETENTION done: deleted={deleted} kept-prefix=opendots/")
# restore test: download the object we just uploaded, gunzip, count rows
r = s3.get_object(Bucket=BUCKET, Key=key)
dl = f + '.dl'
with open(dl, 'wb') as out: out.write(r['Body'].read())
if os.path.getsize(dl) != local: print('RESTORE FAIL size mismatch'); sys.exit(1)
print(f"R2GET OK {key} remote={local} restored-local={os.path.getsize(dl)}")
P
gunzip -c "$T/opendots.sqlite.gz.dl" > "$T/restore.sqlite"
echo "RESTORE-TEST rows: dots=$(sqlite3 $T/restore.sqlite 'select count(*) from dots') spaces=$(sqlite3 $T/restore.sqlite 'select count(*) from spaces') memories=$(sqlite3 $T/restore.sqlite 'select count(*) from memories') computer_permissions=$(sqlite3 $T/restore.sqlite 'select count(*) from computer_permissions')"
echo "BACKUP DONE $DATE"

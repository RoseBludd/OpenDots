#!/usr/bin/env python3
"""opendots-seat-sync service (WO-TWIN-05).

Hardened version of /root/bin/opendots-seat-sync.py (the OWNER-lock, every-15-min
R2 sync of shared seat folders between host OpenDots and TRILL:
R2 genius-agent-twins handoff/seats/<desk>/ (+ handoff/progress/<desk>.md,
ROUTING.md, APPROVALS.md). One owner per desk via handoff/seats/<desk>/OWNER
(host|trill): the host pushes only desks it owns and pulls the rest.

Hardening added by WO-TWIN-05:
- Conflict detection: when a key changed on BOTH sides since the last sync, a
  conflict record (both snapshots) is uploaded to R2 handoff/seats/_conflicts/
  and the OWNER side wins (host-owned: local; trill-owned: remote).
- Dry-run mode (--dry-run / SEAT_SYNC_DRY_RUN=1): full pass, zero writes.
- One `metrics ...` line per cycle (machine-readable summary for the log).
- Skip list: --skip (repeatable/comma list) or SEAT_SYNC_SKIP (comma list).
  Entries match a desk name or a key substring. Defaults skip handoff/WORKLOG.md
  and handoff/ACTIVE.md (sync-rules.sh owns those) and handoff/seats/_conflicts/.
- Service mode: --loop <seconds> keeps the sync running continuously (systemd
  unit in this directory); default is one pass (cron-compatible).

Credentials: --env-file (default /opt/agent-twins/.env, mode 600, never printed)
or R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET in the env.
Never prints credentials. No sends, no WORKLOG/ACTIVE writes, no WO files.
"""
import argparse
import base64
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

SEATS_PREFIX = 'handoff/seats/'
PROGRESS_PREFIX = 'handoff/progress/'
CONFLICT_PREFIX = 'handoff/seats/_conflicts/'
OWNER_SUFFIX = '/OWNER'
# Ownership (hard constraint): sync-rules.sh owns WORKLOG.md + ACTIVE.md; the
# conflict bucket is our own internal area and is never synced back.
DEFAULT_SKIP = ('handoff/WORKLOG.md', 'handoff/ACTIVE.md', CONFLICT_PREFIX)
JUNK = ('.tmp', '~', '.swp', '.DS_Store', 'Thumbs.db', 'desktop.ini')
CONFLICT_PAYLOAD_LIMIT = 1 << 20  # 1 MiB per side; bigger sides are metadata-only


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def make_s3(env):
    import boto3  # lazy: tests inject a fake instead
    return boto3.client(
        's3', region_name='auto', endpoint_url=env['R2_ENDPOINT'],
        aws_access_key_id=env['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])


def local_sig(path):
    try:
        st = os.stat(path)
        return [st.st_size, int(st.st_mtime)]
    except FileNotFoundError:
        return None


def norm_state(entry):
    """Migrate the old {key: [size, mtime]} state to {key: {local, remote}}."""
    if entry is None:
        return None
    if isinstance(entry, list):
        return {'local': entry, 'remote': None}
    return {'local': entry.get('local'), 'remote': entry.get('remote')}


class SeatSync:
    def __init__(self, s3, bucket, root, state_path, skip=(), dry_run=False,
                 log=None):
        self.s3 = s3
        self.bucket = bucket
        self.root = root.rstrip('/')
        self.state_path = state_path
        self.skip = tuple(DEFAULT_SKIP) + tuple(skip)
        self.dry_run = dry_run
        self.log = log or (lambda msg: print(time.strftime('%F %T'), msg, flush=True))

    # --- remote / local helpers -------------------------------------------------

    def listing(self, prefix):
        out = {}
        pg = self.s3.get_paginator('list_objects_v2')
        for page in pg.paginate(Bucket=self.bucket, Prefix=prefix):
            for o in page.get('Contents', []):
                out[o['Key']] = [o['Size'], o['LastModified'].timestamp()]
        return out

    def owner(self, desk):
        p = os.path.join(self.root, 'seats', desk, 'OWNER')
        try:
            with open(p) as f:
                return f.read().split()[0].strip().lower()
        except Exception:
            return 'trill'

    @staticmethod
    def desk_of(key):
        parts = key.split('/')
        if parts[1] == 'seats' and len(parts) > 3:
            return parts[2]
        if parts[1] == 'progress' and len(parts) == 3:
            return parts[2].rsplit('.', 1)[0]
        return None

    def skipped(self, key):
        desk = self.desk_of(key) or ''
        for s in self.skip:
            if s == desk or s in key:
                return True
        return key.endswith(JUNK) or key.endswith(OWNER_SUFFIX) or key.endswith('/OWNER')

    def local_path(self, key):
        return os.path.join(self.root, key[len('handoff/'):])

    # --- conflict records -------------------------------------------------------

    def conflict_key(self, key, ts):
        parts = key.split('/')
        if parts[1] == 'seats':
            desk, name = parts[2], '/'.join(parts[3:])
        elif parts[1] == 'progress':
            desk, name = parts[2].rsplit('.', 1)[0], '_progress/' + parts[2]
        else:
            desk, name = '_shared', parts[1]
        return f'{CONFLICT_PREFIX}{desk}/{name}__{int(ts)}.json'

    def write_conflict(self, key, lpath, remote_now):
        """Upload a JSON record with both snapshots to R2 _conflicts/. Returns the key."""
        ts = time.time()
        record = {
            'key': key,
            'ts': ts,
            'owner': self.owner(self.desk_of(key) or ''),
            'local': {'sig': local_sig(lpath) if lpath else None, 'data': None},
            'remote': {'sig': remote_now, 'data': None},
        }
        if lpath and os.path.exists(lpath):
            try:
                with open(lpath, 'rb') as f:
                    data = f.read(CONFLICT_PAYLOAD_LIMIT + 1)
                record['local']['data'] = base64.b64encode(data[:CONFLICT_PAYLOAD_LIMIT]).decode()
                record['local']['truncated'] = len(data) > CONFLICT_PAYLOAD_LIMIT
            except OSError as e:
                record['local']['error'] = repr(e)[:120]
        tmp = tempfile.NamedTemporaryFile(prefix='seat-sync-conflict-', suffix='.json', delete=False)
        try:
            self.s3.download_file(self.bucket, key, tmp.name)
            with open(tmp.name, 'rb') as f:
                data = f.read(CONFLICT_PAYLOAD_LIMIT + 1)
            record['remote']['data'] = base64.b64encode(data[:CONFLICT_PAYLOAD_LIMIT]).decode()
            record['remote']['truncated'] = len(data) > CONFLICT_PAYLOAD_LIMIT
        except Exception as e:
            record['remote']['error'] = repr(e)[:120]
        finally:
            with open(tmp.name, 'w') as f:
                json.dump(record, f)
            ck = self.conflict_key(key, ts)
            self.s3.upload_file(tmp.name, self.bucket, ck)
            os.unlink(tmp.name)
        return ck

    # --- sync passes ------------------------------------------------------------

    def pull_pass(self, remote, initial, state, metrics, resolved):
        """Non-owner desks (all desks with --initial) + progress + shared files are pull-only."""
        need_pull, new_state = [], {}
        for key, remote_now in sorted(remote.items()):
            if self.skipped(key):
                continue
            if not initial and self.owner(self.desk_of(key) or '') == 'host':
                continue  # host-owned: pull is a no-op, push pass owns it
            lpath = self.local_path(key)
            lnow = local_sig(lpath)
            st = norm_state(state.get(key))
            local_changed = st is not None and st['local'] is not None and lnow != st['local']
            remote_changed = st is not None and st['remote'] is not None and remote_now != st['remote']
            if local_changed and remote_changed:
                metrics['conflicts'] += 1
                if self.dry_run:
                    self.log(f'DRY conflict {key} local={lnow} remote={remote_now} (owner={self.owner(self.desk_of(key) or "")})')
                    continue
                ck = self.write_conflict(key, lpath, remote_now)
                metrics['conflict_files'] += 1
                winner = 'local' if self.owner(self.desk_of(key) or '') == 'host' else 'remote'
                self.log(f'CONFLICT {key} owner={self.owner(self.desk_of(key) or "")} winner={winner} record={ck}')
                if winner == 'remote':
                    need_pull.append((key, remote_now))
                else:
                    resolved.add(key)  # push pass must not record this conflict again
                    new_state[key] = {'local': lnow, 'remote': st['remote']}
                continue
            if lnow is None or lnow[0] != remote_now[0] or lnow[1] < remote_now[1] - 2:
                need_pull.append((key, remote_now))
            else:
                new_state[key] = {'local': lnow, 'remote': remote_now}
        metrics['pulled'] += self._download(need_pull, new_state)
        return new_state

    def _download(self, need_pull, new_state):
        if self.dry_run:
            for key, _ in need_pull:
                self.log(f'DRY pull {key}')
            return len(need_pull)

        def one(kv):
            key, (sz, lm) = kv
            p = self.local_path(key)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            self.s3.download_file(self.bucket, key, p + '.part')
            os.replace(p + '.part', p)
            os.utime(p, (lm, lm))
            new_state[key] = {'local': [sz, int(lm)], 'remote': [sz, lm]}
            return 1

        with ThreadPoolExecutor(8) as ex:
            return sum(ex.map(one, need_pull))

    def push_pass(self, remote, state, metrics, resolved):
        """Host-owned desks are pushed; everything else is pull-only (never pushed)."""
        new_state = {}
        for desk in sorted(os.listdir(os.path.join(self.root, 'seats'))) \
                if os.path.isdir(os.path.join(self.root, 'seats')) else []:
            if self.owner(desk) != 'host' or any(s == desk for s in self.skip):
                continue
            metrics['push_desks'].append(desk)
            files = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(self.root, 'seats', desk)) for f in fs]
            pg = os.path.join(self.root, 'progress', f'{desk}.md')
            if os.path.exists(pg):
                files.append(pg)
            for p in files:
                key = 'handoff/' + os.path.relpath(p, self.root)
                if self.skipped(key):
                    continue
                lnow = local_sig(p)
                st = norm_state(state.get(key))
                local_changed = st is not None and st['local'] is not None and lnow != st['local']
                remote_now = remote.get(key)
                remote_changed = st is not None and st['remote'] is not None and \
                    (remote_now is None or remote_now != st['remote'])
                if st is None or local_changed:
                    if local_changed and remote_changed and key not in resolved:
                        metrics['conflicts'] += 1
                        if not self.dry_run:
                            ck = self.write_conflict(key, p, remote_now)
                            metrics['conflict_files'] += 1
                            self.log(f'CONFLICT {key} owner=host winner=local record={ck}')
                        else:
                            self.log(f'DRY conflict {key} local={lnow} remote={remote_now}')
                    if self.dry_run:
                        self.log(f'DRY push {key}')
                        metrics['pushed'] += 1
                        continue
                    self.s3.upload_file(p, self.bucket, key)
                    new_state[key] = {'local': lnow, 'remote': lnow}
                    metrics['pushed'] += 1
                elif remote_changed and key not in resolved:
                    self.log(f'WARN remote drift on host-owned {key} remote={remote_now} (local wins, not overwritten)')
                if not self.dry_run and st is not None:
                    new_state.setdefault(key, st)
        return new_state

    # --- main cycle -------------------------------------------------------------

    def run(self, initial=False):
        started = time.time()
        metrics = {'pulled': 0, 'pushed': 0, 'conflicts': 0, 'conflict_files': 0,
                   'skipped': 0, 'junk': 0, 'push_desks': [], 'dry_run': self.dry_run}
        state = {}
        if os.path.exists(self.state_path):
            with open(self.state_path) as f:
                state = json.load(f)
        state = {k: norm_state(v) for k, v in state.items()}

        remote = self.listing(SEATS_PREFIX)
        remote.update(self.listing(PROGRESS_PREFIX))
        for k in ('handoff/ROUTING.md', 'handoff/APPROVALS.md'):
            try:
                h = self.s3.head_object(Bucket=self.bucket, Key=k)
                remote[k] = [h['ContentLength'], h['LastModified'].timestamp()]
            except Exception:
                pass
        junk = [k for k in remote if k.endswith(JUNK)]
        skipped = [k for k in remote if self.skipped(k) and k not in junk]
        metrics['junk'] = len(junk)
        metrics['skipped'] = len(skipped)
        for k in junk + skipped:
            remote.pop(k, None)

        merged = dict(state)
        resolved = set()
        merged.update(self.pull_pass(remote, initial, state, metrics, resolved))
        if not initial:
            merged.update(self.push_pass(remote, state, metrics, resolved))

        if not self.dry_run:
            os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
            tmp = self.state_path + '.part'
            with open(tmp, 'w') as f:
                json.dump(merged, f)
            os.replace(tmp, self.state_path)

        metrics['duration_ms'] = int((time.time() - started) * 1000)
        metrics['push_desks'] = ','.join(metrics['push_desks']) or '-'
        seats = os.path.join(self.root, 'seats')
        host_desks = [d for d in sorted(os.listdir(seats)) if self.owner(d) == 'host'] \
            if os.path.isdir(seats) else []
        self.log(
            f"metrics ts={time.strftime('%F %T')} dry_run={int(self.dry_run)} "
            f"pulled={metrics['pulled']} pushed={metrics['pushed']} "
            f"conflicts={metrics['conflicts']} conflict_files={metrics['conflict_files']} "
            f"skipped={metrics['skipped']} junk={metrics['junk']} "
            f"push_desks={metrics['push_desks']} host_desks={','.join(host_desks) or '-'} "
            f"duration_ms={metrics['duration_ms']}")
        return metrics


def main(argv=None):
    ap = argparse.ArgumentParser(description='opendots-seat-sync service (WO-TWIN-05)')
    ap.add_argument('--initial', action='store_true', help='pull everything once (bootstrap)')
    ap.add_argument('--dry-run', action='store_true', help='compute everything, write nothing')
    ap.add_argument('--loop', type=int, metavar='SECONDS', help='run forever, sleeping SECONDS between passes')
    ap.add_argument('--skip', action='append', default=[], metavar='ENTRY',
                    help='desk name or key substring to skip (repeatable, comma-separated too)')
    ap.add_argument('--env-file', default=os.environ.get('SEAT_SYNC_ENV_FILE', '/opt/agent-twins/.env'))
    ap.add_argument('--root', default=os.environ.get('SEAT_SYNC_ROOT', '/mnt/genius_vol_2/opendots/handoff'))
    ap.add_argument('--state', default=None, help='state file (default <root>/.seat-sync-state.json)')
    args = ap.parse_args(argv)

    skip = [s.strip() for a in args.skip for s in a.split(',') if s.strip()]
    if os.environ.get('SEAT_SYNC_SKIP'):
        skip += [s.strip() for s in os.environ['SEAT_SYNC_SKIP'].split(',') if s.strip()]
    dry = args.dry_run or os.environ.get('SEAT_SYNC_DRY_RUN') == '1'

    env = {k: os.environ[k] for k in ('R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET') if k in os.environ}
    if not set(('R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET')) <= env.keys():
        env = load_env(args.env_file)
    s3 = make_s3(env)

    sync = SeatSync(s3, env['R2_BUCKET'], args.root,
                    args.state or os.path.join(args.root, '.seat-sync-state.json'),
                    skip=skip, dry_run=dry)
    if args.loop:
        while True:
            try:
                sync.run(initial=args.initial)
            except Exception as e:
                sync.log(f'ERROR {type(e).__name__}: {str(e)[:300]}')
            time.sleep(max(30, args.loop))
    sync.run(initial=args.initial)


if __name__ == '__main__':
    main()

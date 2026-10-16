#!/usr/bin/env python3
"""Acceptance test for the WO-TWIN-05 hardened seat-sync service.

Scenario: two fake desks (OWNER files decide ownership), a fake in-memory R2,
and a temp handoff root. Covers:
  1. Owner push       - a file in the host-owned desk is pushed to R2.
  2. Non-owner pull   - a file in the trill-owned desk is pulled and local
                        edits to it are NEVER pushed (pull-only mirror).
  3. Conflict         - a key changed on BOTH sides since the last sync ->
                        one conflict record written to R2
                        handoff/seats/_conflicts/<desk>/..., owner side wins.
  4. Dry-run, skip list, WORKLOG/ACTIVE.md never written, metrics line.

Run: python3 services/seat-sync/test_seat_sync.py   (exit 0 = pass)
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from seat_sync import CONFLICT_PREFIX, SeatSync  # noqa: E402


class FakeNotFound(Exception):
    def __init__(self):
        super().__init__('404')
        self.response = {'Error': {'Code': '404'}}


class FakeDT:
    def __init__(self, ts):
        self._ts = ts

    def timestamp(self):
        return self._ts


class FakeR2:
    """In-memory stand-in for the boto3 R2 client surface the service uses."""

    def __init__(self):
        self.objects = {}  # key -> (bytes, ts)

    def put(self, key, data, ts=None):
        self.objects[key] = (data, ts if ts is not None else time.time())

    def upload_file(self, Filename, Bucket, Key, Config=None, ExtraArgs=None):
        with open(Filename, 'rb') as f:
            self.put(Key, f.read())

    def download_file(self, Bucket, Key, Filename):
        if Key not in self.objects:
            raise FakeNotFound()
        with open(Filename, 'wb') as f:
            f.write(self.objects[Key][0])

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FakeNotFound()
        data, ts = self.objects[Key]
        return {'ContentLength': len(data), 'LastModified': FakeDT(ts)}

    def get_paginator(self, _op):
        class Pg:
            def paginate(_self, Bucket=None, Prefix=None):
                yield {'Contents': [
                    {'Key': k, 'Size': len(d), 'LastModified': FakeDT(t)}
                    for k, (d, t) in self.objects.items() if k.startswith(Prefix or '')]}

        return Pg()


class Test(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix='seat-sync-test-')
        self.root = os.path.join(self.base, 'handoff')
        self.state = os.path.join(self.base, 'state.json')
        for d in ('seats/hostdesk', 'seats/trilldesk', 'progress'):
            os.makedirs(os.path.join(self.root, d), exist_ok=True)
        open(os.path.join(self.root, 'seats/hostdesk/OWNER'), 'w').write('host\n')
        open(os.path.join(self.root, 'seats/trilldesk/OWNER'), 'w').write('trill\n')
        self.r2 = FakeR2()
        self.sync = SeatSync(self.r2, 'bucket', self.root, self.state)
        self.logs = []
        self.sync.log = lambda msg: self.logs.append(msg)

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def run_sync(self, **kw):
        self.sync.run(**kw)
        self.assertTrue(any(l.startswith('metrics ') for l in self.logs))
        self.assertNotIn('R2_SECRET', ' '.join(self.logs))

    def test_two_fake_desks_owner_push_nonowner_pull_conflict(self):
        # --- setup: remote seed. trill-owned file on R2; host-owned only local.
        t0 = time.time() - 3600
        self.r2.put('handoff/seats/trilldesk/notes.md', b'remote-v1', ts=t0)
        self.r2.put('handoff/WORKLOG.md', b'team worklog - owned by sync-rules.sh', ts=t0)
        self.r2.put('handoff/ACTIVE.md', b'ledger - owned by sync-rules.sh', ts=t0)
        # WORKLOG.md / ACTIVE.md stay on R2 only: default skip list keeps seat-sync
        # from ever writing them (sync-rules.sh owns those).
        with open(self.path('seats/hostdesk/local1.md'), 'w') as f:
            f.write('host-authoritative-v1')

        # --- run 1: owner push + non-owner pull.
        self.run_sync()
        self.assertEqual(self.r2.objects['handoff/seats/hostdesk/local1.md'][0], b'host-authoritative-v1',
                         'owner push: host-owned desk pushed to R2')
        with open(self.path('seats/trilldesk/notes.md')) as f:
            self.assertEqual(f.read(), 'remote-v1', 'non-owner pull: trill desk mirrored locally')
        self.assertFalse(os.path.exists(self.path('WORKLOG.md')), 'ownership: seat-sync never writes WORKLOG.md')
        self.assertFalse(os.path.exists(self.path('ACTIVE.md')), 'ownership: seat-sync never writes ACTIVE.md')
        self.assertFalse([k for k in self.r2.objects if k.startswith(CONFLICT_PREFIX)])
        # non-owner is pull-only: a local edit to the trill desk must NOT be pushed
        with open(self.path('seats/trilldesk/notes.md'), 'a') as f:
            f.write('\nlocal-only-edit')
        self.run_sync()
        self.assertEqual(self.r2.objects['handoff/seats/trilldesk/notes.md'][0], b'remote-v1',
                         'non-owner desk stays pull-only: local edit not pushed')

        # --- run 2: BOTH sides changed since the last sync -> conflict record.
        with open(self.path('seats/trilldesk/notes.md'), 'w') as f:
            f.write('local-edit')
        self.r2.put('handoff/seats/trilldesk/notes.md', b'remote-v2-by-trill', ts=time.time())
        self.run_sync()
        conflicts = [k for k in self.r2.objects if k.startswith(CONFLICT_PREFIX + 'trilldesk/')]
        self.assertEqual(len(conflicts), 1, 'exactly one conflict record written')
        rec = json.loads(self.r2.objects[conflicts[0]][0])
        self.assertEqual(rec['key'], 'handoff/seats/trilldesk/notes.md')
        self.assertEqual(rec['owner'], 'trill')
        self.assertIn('local-edit', base64_data(rec, 'local'))
        self.assertIn('remote-v2-by-trill', base64_data(rec, 'remote'))
        # owner (trill) wins: remote is pulled over the local edit afterwards
        with open(self.path('seats/trilldesk/notes.md')) as f:
            self.assertEqual(f.read(), 'remote-v2-by-trill', 'owner side wins after conflict record')
        self.assertTrue(any(l.startswith('CONFLICT handoff/seats/trilldesk/notes.md') for l in self.logs))

        # --- run 3: owner-side conflict: both sides change on a host-owned desk
        # (desk file AND desk progress file; exactly one record each).
        with open(self.path('seats/hostdesk/local1.md'), 'w') as f:
            f.write('host-edit-locally')
        self.r2.put('handoff/seats/hostdesk/local1.md', b'remote-tamper', ts=time.time())
        with open(self.path('progress/hostdesk.md'), 'w') as f:
            f.write('host-progress-v1')
        self.run_sync()  # new progress file pushed once so both sides have state
        self.assertEqual(self.r2.objects['handoff/progress/hostdesk.md'][0], b'host-progress-v1')
        with open(self.path('progress/hostdesk.md'), 'w') as f:
            f.write('host-progress-edit')
        self.r2.put('handoff/progress/hostdesk.md', b'remote-progress-tamper', ts=time.time())
        self.run_sync()
        conflicts = [k for k in self.r2.objects if k.startswith(CONFLICT_PREFIX + 'hostdesk/')]
        self.assertEqual(len(conflicts), 2)
        self.assertEqual([json.loads(self.r2.objects[k][0])['key'] for k in sorted(conflicts)],
                         ['handoff/progress/hostdesk.md', 'handoff/seats/hostdesk/local1.md'])
        with open(self.path('seats/hostdesk/local1.md')) as f:
            self.assertEqual(f.read(), 'host-edit-locally', 'host owner wins on its own desk')
        self.assertEqual(self.r2.objects['handoff/seats/hostdesk/local1.md'][0], b'host-edit-locally')
        self.assertEqual(self.r2.objects['handoff/progress/hostdesk.md'][0], b'host-progress-edit')

        # --- run 4: dry-run writes nothing; skip list hides a desk.
        with open(self.path('seats/hostdesk/local1.md'), 'w') as f:
            f.write('dry-run-edit')
        before = dict(self.r2.objects)
        self.sync.dry_run = True
        self.sync.run()
        self.sync.dry_run = False
        self.assertEqual(self.r2.objects, before, 'dry-run: no R2 writes')
        self.assertTrue(any('DRY push handoff/seats/hostdesk/local1.md' in l for l in self.logs))

        self.sync.skip = ('hostdesk',)
        with open(self.path('seats/hostdesk/local1.md'), 'w') as f:
            f.write('skipped-edit')
        self.run_sync()
        self.assertEqual(self.r2.objects['handoff/seats/hostdesk/local1.md'][0], b'host-edit-locally',
                         'skip list: skipped desk never pushed')

    def test_conflict_not_synced_back(self):
        # _conflicts/ objects are never re-synced into the seat folders.
        self.r2.put(CONFLICT_PREFIX + 'trilldesk/x.json', b'{}', ts=time.time())
        self.run_sync()
        self.assertFalse(os.path.exists(self.path('seats/_conflicts')),
                         'conflict bucket must stay in R2 only')


def base64_data(rec, side):
    import base64
    return base64.b64decode(rec[side]['data']).decode()


if __name__ == '__main__':
    unittest.main(verbosity=2)

# seat-sync service (WO-TWIN-05)

Hardened version of `/root/bin/opendots-seat-sync.py` (the OWNER-lock R2 sync of
shared seat folders between host OpenDots and TRILL in `genius-agent-twins`
`handoff/seats/<desk>/`, `handoff/progress/<desk>.md`, `ROUTING.md`,
`APPROVALS.md`). One owner per desk via `handoff/seats/<desk>/OWNER`
(`host`|`trill`): the host **pushes only desks it owns** and **pull-only mirrors**
the rest.

Reuses: `/root/bin/opendots-seat-sync.py` (owner lock + every-15-min cadence),
`/root/oppi-twins/sync-rules.sh` (owns WORKLOG.md/ACTIVE.md — skipped here),
Hermes `cron/ledger.py` + `delivery_queue.py` (append-only/metrics patterns),
`/root/bin/oppi-eco-r2.py` (env-file + credential handling).

## Hardening over the original script

| Feature | How |
| --- | --- |
| Conflict detection | Key changed on **both** sides since the last sync -> one JSON record with both snapshots uploaded to R2 `handoff/seats/_conflicts/<desk>/<name>__<epoch>.json`; OWNER side wins (host-owned: local, trill-owned: remote). |
| Dry-run mode | `--dry-run` or `SEAT_SYNC_DRY_RUN=1`: full pass computed, zero writes (no uploads, downloads or state writes), every action logged as `DRY ...`. |
| Metrics line | One `metrics ts=... dry_run=... pulled=N pushed=N conflicts=N conflict_files=N skipped=N junk=N push_desks=... host_desks=... duration_ms=N` line per cycle. |
| Skip list | `--skip ENTRY` (repeatable/comma) or `SEAT_SYNC_SKIP` (comma). Entries match a desk name or a key substring. Defaults: `handoff/WORKLOG.md`, `handoff/ACTIVE.md` (sync-rules.sh owns those), `handoff/seats/_conflicts/` (never synced back), junk files, `OWNER` files. |
| Service mode | `--loop SECONDS` runs continuously (systemd unit in this dir, default 900 s = the original 15-min cron); no args = one pass, cron-compatible. |
| State migration | Old state `{key: [size, mtime]}` is auto-migrated to `{key: {local: [...], remote: [...]}}`; unknown remotes never produce false conflicts. |

## Usage

```sh
# one pass (cron-compatible), like the original script
python3 services/seat-sync/seat_sync.py

# continuous service, every 15 min, dry-run first
python3 services/seat-sync/seat_sync.py --dry-run
python3 services/seat-sync/seat_sync.py --loop 900 --skip dead-desk,STANDING-RULES.md
```

Credentials come from `--env-file` (default `/opt/agent-twins/.env`, mode 600)
or `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` in
the environment. Secrets are never printed, never in argv.

Ownership constraints honoured: this service never writes
`handoff/WORKLOG.md`, `handoff/ACTIVE.md` (`sync-rules.sh` owns them) or the
devvy work-order lanes; no sends, no public exposure.

## Test

```sh
python3 services/seat-sync/test_seat_sync.py
```

Two fake desks + in-memory R2: owner push, non-owner pull-only, conflict file
written under `handoff/seats/_conflicts/`, dry-run writes nothing, skip list
honoured, WORKLOG/ACTIVE never written locally.

TRILL-side push: see `TRILL-PUSH-DESIGN.md` (design only — TRILL changes need
Juelzs).

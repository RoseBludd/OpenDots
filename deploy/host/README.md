# WO-TWIN-01 — Headless host deploy, Tailscale-only auth, sqlite→R2 backup

Canonical, reproducible copy of the OpenDots host deployment that oppi. installed on
2026-10-16 (log: `/var/log/oppi-opendots-install.log`). Before this, the compose file and
scripts only lived on the host under `/root/oppi-exec/od/` and `/root/bin/`; this directory
is now the source of truth and re-deploys are idempotent.

Reuses (existing components):
- Install assets: host `/root/oppi-exec/od/{compose.host.yml,install.sh,stage2.sh,cap-guard.sh,seat-sync.py}` (copied here verbatim, plus the guard changes below).
- R2 uploader: `/root/bin/oppi-eco-r2.py` (same-size HEAD verify) — same creds/bucket conventions; the backup script uses the same boto3 pattern and `/opt/agent-twins/.env` env file (mode 600, never printed, never in argv).
- AgentConnect health patterns: `/opt/agentconnect/packages/observability/` (read-only reference for the health script's check/report shape).

## Layout

| File | Purpose |
|---|---|
| `compose.host.yml` | app + computer-supervisor + **tailnet-guard** sidecar. Caps: app 0.5 CPU/768M, supervisor 0.25/256M, computers 1G/0.5 CPU, max 2 running. |
| `tailnet-guard.mjs` | Zero-dependency Node edge guard (runs inside the existing `opendots-app` image, `network_mode: host`). Listens only on `127.0.0.1:4320` and `100.86.225.40:4320`; refuses any source outside `100.64.0.0/10` + loopback with `403`; forwards to the app's loopback-only edge `127.0.0.1:4321`. |
| `install.sh` | First-boot install (images, files, seats, env generation 0600, start). Idempotent: env is only created if missing, seats are pulled and re-stamped. |
| `deploy.sh` | Idempotent re-deploy: install repo files to their host locations, `docker compose up -d` (no rebuild needed — guard reuses the app image), ensure cron lines. Safe to run repeatedly. |
| `stage2.sh` | One-time data import (desk Dots, spaces, memories), cron registration, desk checks. |
| `cap-guard.sh` | Per-minute resource guard (installed as `/root/bin/opendots-cap-guard.sh`). |
| `seat-sync.py` | R2 seat sync (installed as `/root/bin/opendots-seat-sync.py`). |
| `backup-r2.sh` | Nightly sqlite→R2 backup + same-size verify + 14-day retention + restore test (installed as `/root/bin/opendots-backup-r2.sh`). |
| `health.sh` | Health check: app `/api/state` with owner bearer, supervisor container health, cap-guard freshness (installed as `/root/bin/opendots-health.sh`). |

## Tailscale-only auth

1. `docker compose` binds the app edge only to `127.0.0.1:4321` (loopback, internal).
2. `tailnet-guard` binds the public edge only to `127.0.0.1:4320` and the tailnet IP
   `100.86.225.40:4320`. Any connection whose source is not loopback or in
   `100.64.0.0/10` (the Tailscale CGNAT range) gets `HTTP/1.1 403` and is destroyed.
   A curl against any other host interface (e.g. the public `eth0` IP) is refused —
   nothing listens there.
3. The owner bearer token (`OWNER_TOKEN` in `/mnt/genius_vol_2/opendots/.env`, 0600) is
   unchanged and still required by `/api/*`. Scripts read it into a curl `--config` file
   (mode 600) instead of argv so it never appears in process listings or logs.

## Nightly sqlite→R2 backup (`backup-r2.sh`)

1. `sqlite3 <volume>/opendots.sqlite ".backup /tmp/..."` (online, consistent snapshot), gzip.
2. Upload to R2 bucket `genius-server-backups`, key `opendots/<YYYY-MM-DD>.sqlite.gz`, then
   HEAD the object and compare sizes (same-size verify, `oppi-eco-r2.py` convention).
3. Retention: list `opendots/*.sqlite.gz`, delete objects older than 14 days — only after
   today's copy is verified to exist.
4. Restore test: download the freshly uploaded object back from R2 into a temp directory,
   `gunzip`, open with sqlite3 and print row counts (`dots`, `spaces`, `memories`,
   `computer_permissions`) — proving the backup is restorable. Temp files cleaned up.
5. Cron: `23 3 * * *` wrapped in `nice`/`ionice`/`timeout`, log `/var/log/opendots-backup.log`.

## Health (`health.sh`)

- app: `GET /api/state` with bearer via curl config file → expect 200.
- supervisor: liveness-only `/health` probe via `docker exec` (per the WO-09 pattern) → expect 200/`healthy`.
- cap-guard: `/var/log/opendots-cap-guard.log` mtime within the last 5 minutes (cap-guard
  writes a per-minute heartbeat line) and a count of running odhost computers.
- tailnet-guard: container healthcheck (self-fetch).
- Prints one `HEALTH` line per check, exits non-zero if any check fails.

## Host constraints worth knowing

- The `opendots-supervisor:b6932d3-dot-auth` image currently fails containerd layer
  extraction on this host (missing snapshot dir `28753`), so **the supervisor container
  must not be recreated** — `deploy.sh` therefore only converges `app` + `tailnet-guard`
  with `--no-deps` and the supervisor keeps running untouched. If the image is
  re-transferred/reloaded later, `docker compose up -d` for it can be run manually.
- `cap-guard.sh` appends a per-minute heartbeat so health.sh can verify liveness even when
  there is nothing to enforce.

## Run

```
git clone ... && cd OpenDots/deploy/host
sudo ./deploy.sh        # idempotent; run again any time
sudo /root/bin/opendots-backup-r2.sh
sudo /root/bin/opendots-health.sh
```

Never `docker system prune -af`; targeted `docker rmi` only. No secrets in argv, logs or R2.

# TRILL-side push design note (WO-TWIN-05)

Status: DESIGN ONLY — not implemented. TRILL-side changes need Juelzs' sign-off
before any code ships on that side, so the host keeps the only write path today.

## Current model (as hardened by WO-TWIN-05)

- One owner per desk: R2 `handoff/seats/<desk>/OWNER` contains `host` or `trill`.
- The host service (`services/seat-sync/seat_sync.py`) pushes only desks it owns
  and pull-only-mirrors everything else. Non-owner local edits are never pushed.
- When a key changed on **both** sides since the last sync, the service writes a
  JSON conflict record (both snapshots, base64, 1 MiB cap per side) to R2
  `handoff/seats/_conflicts/<desk>/<name>__<epoch>.json` and the OWNER side wins.

## TRILL-side push proposal (needs Juelzs)

1. **Reuse the same OWNER lock.** TRILL runs the identical algorithm mirrored:
   push only `OWNER == trill` desks, pull the rest. No new ownership registry,
   no second source of truth — the existing `OWNER` files arbitrate both sides.
2. **Same state-file format.** `{key: {local: [size, mtime], remote: [size, lm]}}`
   so conflict detection is symmetric; a TRILL push conflict against a stale
   remote produces the same `_conflicts/` record shape the host writes.
3. **First-writer keeps the lock.** Both services run `head_object` on
   `handoff/seats/<desk>/OWNER` before acting; if the OWNER file itself conflicts
   (changed remotely), the desk is treated as trill-owned (safe default) and
   surfaced as a conflict record until Juelzs resolves it.
4. **Shared infrastructure (needs Juelzs):** TRILL needs its own R2 credentials
   scoped to `handoff/seats/*` + `handoff/progress/*` (no `twins/*`, no
   `eco-backups/*`), issued by oppi./sec. — same policy as the desk-key HOLD.
5. **Frequency:** TRILL pushes at most every 15 min (same cadence as
   `/root/bin/opendots-seat-sync.py`), jittered by desk name hash to avoid
   lockstep overwrites; conflicts, not stale data, absorb the residue.
6. **Out of scope for both sides, forever:** `handoff/WORKLOG.md`,
   `handoff/ACTIVE.md` (sync-rules.sh owns them), `handoff/ROUTING.md`,
   `handoff/APPROVALS.md` (head-pull only), and the WO files under devvy lanes.

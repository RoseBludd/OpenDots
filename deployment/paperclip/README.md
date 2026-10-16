# Paperclip → OpenDots wake bridge (WO-TWIN-06)

Accepts the same wake/run contract Paperclip's `hermes_gateway` adapter already
sends to the Hermes API server on :8642, so Paperclip needs only an
`apiBaseUrl` change.

- Route: `/paperclip/v1/runs` (POST), `/paperclip/v1/runs/{run_id}` (GET),
  `/paperclip/v1/runs/{run_id}/stop` (POST), `/paperclip/v1/models` (GET),
  `/paperclip/health` (GET). Code: `src/server/paperclip-bridge.ts`, mounted
  once in `src/server/app.ts`.
- Auth: `Authorization: Bearer $PAPERCLIP_BRIDGE_TOKEN` (dedicated bridge
  token, env file mode 600 — never the owner token). The bridge is disabled
  (404) when the token is unset.
- Network: loopback and tailnet only (`PAPERCLIP_BRIDGE_ALLOWED_NETS`, default
  `127.0.0.1,::1,100.64.0.0/10`). Off-tailnet callers get 403.
- Mapping: `desk-map.tsv` (`company<TAB>agent<TAB>dot id-or-name`), falling
  back to the Dots table (agent id or exact Dot name). The wake creates a task
  in the desk Dot's standing thread and answers `{run_id, status: "queued"}`.
- Idempotency: a repeated `Idempotency-Key` (the Paperclip run id) returns the
  original run — no duplicate tasks.
- Status: OpenDots task states map onto the Hermes run states the adapter's
  poller accepts (`queued`, `running`, `completed`, `failed`,
  `cancelled`/`interrupted` for paused); `output` carries the finished run's
  text. `GET /v1/runs/{id}/events` returns 405 — the adapter falls back to
  polling, which the bridge serves.

## Pilot (genius-substrates only)

See `genius-substrates.pilot.paperclip.yaml` for the staged agent config
change (`apiBaseUrl: http://10.0.1.1:4320/paperclip`). Keep Hermes :8642 and
hermes-core running unchanged; every other company stays on Hermes until the
7-day pilot proves no missed or duplicate wakes, then cut over the remaining
companies with the same two-line change.

## Proof checklist

1. `curl http://127.0.0.1:4310/paperclip/health` → 200.
2. `curl -K <(printf 'url = "http://10.0.1.1:4310/paperclip/v1/runs"\nheader = "Authorization: Bearer %s"\n' "$PAPERCLIP_BRIDGE_TOKEN") -H 'Content-Type: application/json' -H 'X-Hermes-Session-Key: paperclip:company:genius-substrates:agent:devvy:issue:pilot' --data '{"input":"Pilot wake from Paperclip","instructions":"Follow the Paperclip wake instructions exactly."}'` → run_id.
3. `curl http://127.0.0.1:8642/health` (Hermes) still → 200 after the change.
4. The task appears in the desk Dot's thread; Paperclip shows the run result.

Note: Dot runs need a model or Intelligence (keys held), so the pilot proof is
"task created in the desk thread with the run id", not "Dot answered".

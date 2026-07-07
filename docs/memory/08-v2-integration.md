# v2 metaverse integration and repository restructure

## Decision — Big Data is the detector of record; v2 metaverse is the data source
*decision · 2026-07-07*

The teammate delivered a v2 metaverse (`SEMINARIO.zip` → `desarrollo/v2`). Unlike
v1 (browser sim + mock Kafka + a Python WS↔Kafka bridge), v2 is a
**server-authoritative** multiplayer app: a Node server (run with **bun**) runs
the whole simulation at 20 Hz and produces to real Kafka via kafkajs; browsers
are thin renderers. Critically, v2 shipped with its OWN red-zone detection in Node
(`src/analytics/zones.js`), so as-delivered it never used Spark.

The user decided the Spark/Kafka pipeline is **the detector of record**; the
metaverse is purely the data source + renderer + rerouter. The Node internal
detection is disconnected (not the source of truth). This keeps the grade
project's H1 honest — the streaming architecture must be what detects.

## Architecture — three integration seams, no bridge
*architecture · 2026-07-07*

Because the Node server already speaks Kafka natively, the v1 Python bridge is
obsolete. Integration reduced to three seams:

1. **`avatar-positions` producer** (`metaverse/server/simulation.js`): per-avatar
   at 1 Hz, `{avatar_id:"${room}-${i}", x:posX, y:posZ, speed, ts:ISO-8601}`.
   Speed is **measured displacement** (`server/speed.js measuredSpeedMps`), not the
   desired `speed[i]` — a stuck car must report ~0 or the `speed < 0.5` detector
   filter goes blind (the v1 lesson, carried forward and now unit-tested).
2. **Spark detector** (`pipeline/red_point_detector.py`, unchanged): consumes
   `avatar-positions`, emits `red-points`.
3. **`red-points` consumer** (`metaverse/analytics/redPoints.js RedPointStore`):
   maps `center_x/center_y` → 6×6 zone via `server/zoneGrid.js zoneIndexAt`, 30 s
   TTL, drives `world_snapshot.rz` + rerouting. Internal ZoneSystem detection
   disconnected (`step()` no longer calls `zones.update`; kept as dead code).

Dev↔prod parity via env only (`KAFKA_BOOTSTRAP` / `EVENTHUBS_CONNECTION_STRING`),
mirroring the detector. Contract: `docs/integration-contract.md`.

## Restructure — one organized tree, no legacy, no browser-only mode
*pattern · 2026-07-07*

Promoted to a concern-organized layout: `metaverse/` (source+render, bun),
`pipeline/` (Spark detector), `infra/` (Terraform prod), `env/` (dev/prod
profiles), `scripts/`, `tests/`, `docs/`. Removed: `desarrollo/` (v1 + leftovers),
`backend/` (Python bridge), `simulator/` (synthetic load — the metaverse is the
real source), root `docker-compose.yml` (port-8080 clash), `README-local.md`
(→ `README.md`), and the front offline/browser-only mode (`simulacion.js`,
`dashboard.js`, `store.js`; shared world builders extracted to `worldBuilders.js`).
The reference PDF stays at the repo root, gitignored.

## Hardening — adversarial review fixes + first tests
*bugfix · 2026-07-07*

Blind reliability + resilience reviews of the Kafka seams. Fixes applied:
split-brain fallback (RedPointStore no longer listens to a dead in-process bus
when the bridge is in kafka mode — fails loud), replay-resurrect (ephemeral
consumer groupId + `fromBeginning:false` so a restart doesn't revive stale zones),
batched `avatar-positions` (one produce per room per second, not up to 500),
loud-fail on an unparseable `EVENTHUBS_CONNECTION_STRING` (no silent fallback to
localhost with SASL), and SIGINT/SIGTERM clean shutdown.

First automated JS tests added (`metaverse/tests/integration.test.js`, `bun test`,
11 passing): measured-speed (stuck → 0), `zoneIndexAt`, and `RedPointStore`
(including a guard that a renamed Spark field yields no zone). A Python test
(`tests/test_position_parsing.py`) locks the JS ISO-8601 'Z' timestamp → Spark
`to_timestamp` seam. Verified: `bun test` 11/11, `bun build` server OK, `vite
build` OK, `py_compile` OK. The Spark tests need the distrobox (Java) to run.

## Deferred items — completed
*bugfix · 2026-07-07*

The items deferred right after the integration were then finished and verified
against real Spark + Kafka in the distrobox:

- **Per-room detection**: the detector groups by `(room, cell)` and `red-points`
  carries `room`; the metaverse applies red zones per room, so simultaneous rooms
  no longer pool their congestion.
- **ADLS / historical archiving**: an optional second Spark write stream appends
  parsed `avatar-positions` to Parquet when `ARCHIVE_PATH` is set (local dir in
  dev, `abfss://…` ADLS in prod).
- **avatar_id epoch nonce**: `${room}-${epoch}-${i}` survives room-code reuse.
- **Observability**: 30 s heartbeat of the Kafka counters + consumer `CRASH`
  listeners.
- **Reroute ETA**: the personal-vehicle offer reports a penalty-based ETA instead
  of the hardcoded fallback.
- **Admin heatmap**: renders the Spark-detected red zones (internal detection
  stays disconnected).

**Still open — external blocker:** the Azure phase (activate the subscription,
`terraform apply`, Databricks, cloud E2E) depends on the user activating an Azure
subscription. And the full browser E2E (avatars → painted zone → reroute) is the
user's manual verification step.

**Env note:** the `seminario` distrobox does not exist on the current host; run
`distrobox assemble create --file distrobox.ini` before running anything.

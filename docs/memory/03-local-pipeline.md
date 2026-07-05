# Local pipeline: Kafka + Spark red-point detector + simulator

## Implementation
*architecture · 2026-07-03*

Built the full local red-point detection pipeline: `docker-compose.yml`
(apache/kafka:3.9.0 KRaft single-node, kafbat/kafka-ui on :8080, floci-az on
:4577), `analytics/red_point_detector.py` (PySpark 3.5.1 Structured Streaming,
Kafka connector via `spark.jars.packages`), `simulator/producer.py` +
`consumer.py` (confluent-kafka), `README-local.md`, `requirements.txt`.

**Key design:**
- Event schema `{"avatar_id","x","y","speed","ts"(ISO)}` on topic
  `avatar-positions`; output topic `red-points` with cell + center coords +
  stationary count + window.
- Detection: filter `speed < 0.5`, `groupBy` sliding `window(60s, 10s)` + grid
  cell `(floor(x/100), floor(y/100))`, `approx_count_distinct(avatar_id) >= 5`,
  watermark 30s, output mode `update` (low latency; consumer dedupes by cell key).
- Azure portability: `EVENTHUBS_CONNECTION_STRING` env switches Kafka options to
  `SASL_SSL` with the `$ConnectionString` username — same code local and Azure.
- Simulator: 50 avatars A(0,0)→B(1000,1000), staggered departures 0–30s,
  blockage circle r=60 at (500,500) activates at t=20s.

## Validation and endpoint false-positive fix
*bugfix · 2026-07-03*

Live review of the running pipeline (~12 min): 33,150 events in
`avatar-positions`, 3,846 in `red-points`; detection correct at cell (4,4)
matching the blockage at (500,500) r=60 (avatars stop near (457,457)).

**False positive found:** the first red points were cell (0,0) with 39
"stationary" avatars — staggered-departure avatars emitted `speed=0` from A before
departing; the same defect would fire at destination B.

**Fix:** added `Avatar.is_active()` in `simulator/producer.py` — telemetry is
emitted only between departure and arrival. The log now shows `active=N`.

**Learned:**
- `approx_count_distinct` (HyperLogLog) reported 49/50 stuck avatars — ~2% error
  by design, fine for threshold decisions (thesis material: accuracy vs latency).
- Red points never "clear" (stuck avatars emit forever; each new window
  re-emits). Future work: a "blockage resolved" event.
- Review method: inspect topics directly via `distrobox enter` +
  `kafka-get-offsets.sh` / `kafka-console-consumer.sh` from the host shell.

**Also created:** `docs/arquitectura.drawio` — two pages: "Producción (Azure)"
(Three.js ↔ backend ↔ Event Hubs ↔ Databricks ↔ ADLS, budget alert, Terraform RG)
and "Dev/QA (Local — Distrobox)" (native Kafka, PySpark, simulators, parity note).

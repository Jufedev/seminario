# Metaverse ↔ pipeline integration

## Mapped integration gaps
*discovery · 2026-07-04*

Mapped `desarrollo/ecci-metaverse` (Vite + Three.js city sim, vibe-coded) against
the validated Python pipeline to plan full integration. Blockers found:

1. `src/kafka/producer.js` was a MOCK — `console.debug` only; `connect(url)` (raw
   WebSocket, "live" mode) was never called; no env wiring.
2. Topic mismatch: JS emitted dotted topics (`agent.position`, `zone.red`,
   `analytics.snapshot`…); the pipeline/Terraform only knew `avatar-positions` and
   `red-points`.
3. Schema mismatch: JS envelope `{topic, session_id, ts:epoch_ms, ...}` vs Python
   flat `{avatar_id, x, y, speed, ts:ISO-8601}`. Coordinate spaces differ
   (Three.js world x/z vs 0–1000 grid).
4. Duplicated analytics: the browser computed its own red zones in
   `src/analytics/zones.js` and never ingested Spark's `red-points` — parallel
   detectors, not one pipeline.
5. Browsers can't speak the Kafka wire protocol → a WebSocket↔Kafka bridge backend
   is required and was absent.
6. Detector params (`CELL_SIZE` etc.) were already env-tunable — coordinate
   adaptation can be config, not code.

## `agent.position` was an aggregate, not per-avatar
*discovery · 2026-07-04*

The existing `agent.position` Kafka event in `src/sim/agents.js` (~line 175) was
an AGGREGATE sample (moving/waiting/stuck counts + `avg_speed_mps` every
`KAFKA_SAMPLE_MS=500ms`), not per-avatar positions. The detector needs per-avatar
`{avatar_id,x,y,speed,ts}`.

**Decisions:**
1. Add per-avatar `agent.position` events (`agent_id, x, z, speed_mps`) at 1 Hz
   via a new `POSITION_EMIT_MS=1000` timer, emitted ONLY when the WS producer is
   live (avoids log spam in standalone mode).
2. `mapping.py` returns `None` for the legacy aggregate shape so the bridge
   ignores it gracefully.
3. Coordinate mapping: Three.js ground plane (x,z) maps to detector (x,y) — z
   becomes y; ts epoch-ms → ISO-8601 UTC; `avatar_id = sha1(session_id)[:8] + "-" +
   agent_id`.
4. Map bounds `MAP_BOUNDS x:[-180,200], z:[-80,200]` (380×280 units, 1 unit = 4 m)
   → recommended detector `CELL_SIZE=38` for a ~10×7 grid (env var, detector code
   unchanged).

## Implementation
*architecture · 2026-07-04*

Implemented the full integration: `backend/mapping.py` (pure translation),
`backend/bridge.py` (websockets server + confluent_kafka producer/consumer), live
WebSocket mode in `producer.js` (reconnect/backoff, drop-on-disconnect), per-avatar
1 Hz emit (live mode only), detection mode `local`|`pipeline` in
`store`/`config`/`zones.js`, Makefile targets (`bridge`, `metaverse-install`,
`metaverse`), `tests/test_bridge_mapping.py`, `docs/integration-contract.md`,
README section. `requirements.txt` gained `websockets==16.0`.

- **Field contract:** JS `{agent_id, x, z, speed_mps, ts epoch-ms, session_id}` →
  pipeline `{avatar_id: sha1(session_id)[:8]+"-"+agent_id, x, y: z, speed, ts
  ISO-8601 UTC}`. Inverse: red-points `center_y` → WS `center_z`; message tagged
  topic `zone.red`, source `pipeline`.
- **Pipeline mode:** `zones.js` flags zones only from external red points (TTL 30s,
  refreshed by detector update-mode re-emissions), fixed `ZONE_PENALTY_SCALE`
  penalty; local congestion index stays computed as a metric.
- **Dev/prod parity via env only:** localhost:9092 vs Event Hubs 9093 SASL_SSL,
  Container Apps bridge.
- **Gotcha:** permission settings deny creating dotfiles (`.env.example`) in the
  repo; shipped as `env.example` (no dot) and docs reference that name.

## Adversarial review fixes
*bugfix · 2026-07-04*

A fresh-context adversarial review produced 1 CRITICAL + 4 WARNING findings, all
fixed before commit:

1. **CRITICAL** — `agents.js` emitted `speed[i]` (target-chasing *desired* speed):
   cars queued behind a leader reported ~cruise speed, making the Spark detector
   (`speed < 0.5` filter) blind to real jams. Fix: emit MEASURED displacement speed
   between emits (`_emitX/_emitZ/_emitHas` arrays + `_lastEmitSimTime`; first sample
   falls back to `speed[i]`).
2. `bridge.py`: `producer.produce()` `BufferError`/`KafkaException` no longer kills
   the client WS session — drop + counter + throttled warning.
3. `mapping.py`: out-of-range numeric ts (e.g. 1e18) caught → `None`; bridge guards
   `isinstance(topic, str)` against non-hashable topics. Tests added (ts = ±1e18).
4. `simulacion.js`: pipeline mode without a bridge configured now shows a visible
   UI banner + `console.warn` (was: silent zero detection).
5. `Makefile`: `detector` sets `CELL_SIZE?=38` (metaverse default; override
   `CELL_SIZE=100` for the legacy sim plane); `integration-contract.md` corrected
   (cell_size is informative metadata — the browser paints the containing 6×6 local
   zone, not the exact cell).

**Learned:** internal sim speed vs measured displacement is the classic telemetry
trap — same class as the earlier `producer.py` origin false-positive (data quality
at the source). **Deferred** (documented, not fixed): red-point bursts force
repeated zone recompute / snapshot skew; sessionId reuse across same-tab runs.

## E2E validation
*discovery · 2026-07-04*

The user ran the real metaverse in the browser against the live pipeline (Kafka +
Spark detector + bridge) and confirmed red-point detection works end-to-end in
pipeline mode — first human validation, closing the integration milestone
(commits be5e18c / 77bdf3f / 2507281). The user noted "muchas cosas que ajustar a
nivel del metaverso" (UX/sim adjustments pending, unspecified) but detection
itself looked good. **Next session should collect that specific adjustment list.**

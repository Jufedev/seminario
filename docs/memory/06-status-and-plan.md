# Status and plan

## Day-1 status review and closing plan
*decision · 2026-07-03*

Full project status review (day 1 of 15).

**Done:** local pipeline validated E2E, tests green, Terraform written (not
applied), drawio diagrams, bitácora (14 sections).

**Gaps by risk:**
1. No Azure subscription activated — external blocker.
2. Integration contract with the Three.js teammate not delivered (JSON schema +
   topics). *(Later delivered — see `docs/integration-contract.md`.)*
3. Real backend (WebSocket↔Kafka bridge, ~150 lines) unbuilt. *(Later built — see
   `backend/bridge.py`.)*
4. ADLS historical archive not implemented (extra `writeStream` in the detector).
5. H1 measurement is manual — needs a latency measurement script.

**Plan:** D1–2 activate subscriptions + deliver integration contract; D3–5
`terraform apply` + Databricks + cloud E2E with simulator; D6–9 real backend +
Three.js integration; D10–11 ADLS archiving + measurement script + experimental
runs; D12–14 document + demo rehearsal, code freeze.

## Last session summary (2026-07-04)
*session_summary*

**Goal:** integrate the teammate's Three.js metaverse with the validated
Kafka+Spark pipeline, with dev↔prod (Azure) parity.

**Accomplished:** `backend/bridge.py` + `backend/mapping.py` (bridge, dev↔prod
switch via `KAFKA_BOOTSTRAP` / `EVENTHUBS_CONNECTION_STRING`); `producer.js` live
mode (`VITE_BRIDGE_WS_URL`, reconnect/backoff); per-avatar 1 Hz emit with measured
speed; `zone.red` ingestion with a local/pipeline detection-mode toggle (the H1
experiment variable); Makefile targets; `tests/test_bridge_mapping.py`;
`docs/integration-contract.md`; README updates. Adversarial review (1 CRITICAL + 4
warnings) fixed. E2E validated: client→bridge→Kafka→Spark→red-points→bridge→client
round trip works (~1.1 s on a synthetic burst).

**Next steps (open):**
- Hand `docs/integration-contract.md` to the Three.js teammate.
- Live browser demo: `make kafka-start` + `make detector` + `make bridge` +
  `make metaverse` with `VITE_BRIDGE_WS_URL` set and detection mode `pipeline`.
- Deferred review suggestions: debounce zone recompute on red-point bursts;
  regenerate sessionId per connect; paint the exact detector cell instead of the
  containing 6×6 zone; ADLS archiving of other metaverse topics.
- Collect the specific metaverse UX/sim adjustment list from the user.
- **Azure phase still pending: activate subscriptions, `terraform apply`,
  Databricks.**

**Relevant files:** `backend/bridge.py`, `backend/mapping.py`,
`desarrollo/ecci-metaverse/src/kafka/producer.js`, `.../src/sim/agents.js`,
`.../src/analytics/pipeline.js` + `zones.js`, `docs/integration-contract.md`,
`Makefile`.

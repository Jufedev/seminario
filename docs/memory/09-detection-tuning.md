# Detection tuning and the red-zone outage

## Bugfix — red zones stopped appearing: a poisoned Spark checkpoint
*bugfix · 2026-07-10*

Red zones vanished from the browser while every component looked healthy: the server
reported `kafka:kafka`, `avatar-positions` was full, the detector process was up. The
chain was silently broken in the middle.

**Root cause: a stale Spark checkpoint.** Detection parameters had been changed
(window/aggregation), which makes the existing checkpoint **incompatible** with the new
query plan. Spark did not crash — it simply produced nothing. `make clean` (wipe
`checkpoints/`) restored detection immediately.

**Learned — the failure mode is the dangerous part:** an invalid checkpoint does not
fail loudly, it makes the detector go *mute*. Any change to the window or the
aggregation must be followed by `make clean` in dev. In prod the checkpoint also holds
the Event Hubs offsets, so the same change needs a migration plan, not a delete.

Full chain re-verified against real Spark + Kafka afterwards: 21+ avatars, dwell 14 s+,
red zone raised, TTL clearing it ~44 s after the jam dissolved.

## Decision — the "live queue" calibration
*decision · 2026-07-10*

The detector was calibrated against the **measured physics of a real queue** in the
metaverse instead of guessed numbers. A typical jammed cell holds **6–9 avatars**, and
the queue sustains itself for several seconds.

Resulting profile (in `env/env.dev.example` and `env/env.prod.example`):

```
CELL_SIZE_X=30  CELL_SIZE_Y=30  GRID_ORIGIN_X=-240  GRID_ORIGIN_Y=-195
WINDOW_DURATION=10 seconds   WINDOW_SLIDE=5 seconds
MIN_STATIONARY_AVATARS=7     MIN_MEAN_DWELL_S=5
```

**The code defaults were deliberately left at their old values** (30 s window, dwell 12,
5 avatars): the environment profile is the single source of truth for the calibration,
and `scripts/deploy-azure.sh` reads `env/env.prod.example` to configure the Databricks
job. Reading the code defaults and assuming they are what runs is the project's most
common misreading — now documented in `docs/como-funciona.md` §5.

Also tuned: `SPARK_ZONE_PENALTY = 500` (40 was roughly one extra block, so Dijkstra kept
routing straight through the red zone) and the overlay opacity to 0.35 (0.22 was
invisible on screen).

## Discovery — the admin dashboard metrics were dead, and why
*discovery · 2026-07-10*

Disconnecting the metaverse's internal detection (the correct call for H1) had silently
killed four admin-dashboard metrics: they were fed by the very `ZoneSystem` that was
switched off.

**Fix without resurrecting the internal detector:** `ZoneSystem` now runs in
`metricsOnly` mode — it still computes the congestion index C and emits
`analytics.snapshot` (heatmap, C̄, critical zone), but never penalizes edges, reroutes,
or emits `zone.red`/`zone.clear`. The red-zone KPI and its time series come from
`noteSparkRedZones()`, i.e. from the **Spark** count, so the dashboard and the players'
overlay always agree.

**Learned:** "disconnect the internal detector" and "delete its telemetry" are different
operations. The flag that separates them (`metricsOnly`) is now pinned by a test that
proves a `metricsOnly:false` control case *does* penalize — otherwise the flag could
silently become a no-op.

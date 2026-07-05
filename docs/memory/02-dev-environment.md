# Development environment

## Dev environment — 100% Distrobox, no Docker, native Kafka + Makefile
*decision · 2026-07-03*

Everything lives inside the "seminario" distrobox (ubuntu:24.04); Docker was
skipped entirely. Kafka 3.9.1 runs NATIVE (KRaft single-node, official tarball)
via `scripts/kafka-local.sh` (install/start/stop/status/logs/consume; installs to
`~/.local/kafka_2.13-3.9.1`, data in `kraft-data/`, topic auto-create on).

The `Makefile` is the single project interface: `setup`, `test`, `kafka-*`,
`detector`, `consumer`, `producer`, `consume TOPIC=x`, `clean` (removes
checkpoints); `docker-up/down` kept as an alternative. `README-local.md`
documents Opción A (distrobox native, recommended) vs Opción B (docker compose).

**Why:** keep bare-metal CachyOS untouched; a Docker daemon inside a rootless
distrobox is fragile. Kafka is just a JVM app and Java 17 is already in the box.

**Consequence:** Floci (container-based Azure emulator) deferred — run later via
host podman or skip and validate Terraform with `plan` against real Azure. Kafka
UI unavailable in Option A; use `make consume`.

## Session/host facts
*config · 2026-07-04*

The Claude Code session runs INSIDE the distrobox "seminario" (Ubuntu 24.04,
`CONTAINER_ID=seminario`): python3 3.12.3, java 17, make, bun available;
node/npm, docker, and the distrobox CLI are NOT available inside. `git` was
missing and installed via apt. The repo was initialized with baseline commit
`dc143db` "chore: baseline before metaverse integration" (43 files) before
touching the teammate's metaverse code. `node_modules/` and `dist/` are gitignored.

## Bugfix — Spark "Yarn Local dirs can't be empty" inside Distrobox
*bugfix · 2026-07-03*

**Symptom:** Spark failed to start in local mode inside Distrobox with
`java.lang.Exception: Yarn Local dirs can't be empty`.

**Root cause:** Distrobox exports `CONTAINER_ID` for its own container
identification; Spark's `Utils.isRunningInYarnContainer` checks that exact env var
to decide it is running in a YARN container, then requires YARN local dirs that
don't exist.

**Fix:** `os.environ.pop("CONTAINER_ID", None)` before creating the SparkSession
in both `analytics/red_point_detector.py` and `tests/test_detection_logic.py`
(the JVM inherits Python's env, so popping in Python works). Manual workaround:
`unset CONTAINER_ID`.

**Learned:** any Spark-in-dev-container setup (distrobox/toolbox) hits this;
fixing it in code beats documenting a manual step. Producer/consumer
(confluent-kafka, no JVM) are unaffected.

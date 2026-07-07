"""Contract test for the JS producer -> Spark parsing seam — needs Java 17 + PySpark.

The metaverse server emits `avatar-positions` with `ts` produced by JavaScript's
`new Date().toISOString()`, i.e. an ISO-8601 string WITH a trailing `Z`
(e.g. "2026-07-07T12:00:00.000Z"). The detector parses it with a format-free
`F.to_timestamp("ts")`. Whether that shape parses to a non-null timestamp (rather
than silently becoming NULL, which would make `withWatermark` drop every row and
the detector go dark) is the single most fragile part of the integration and was
previously only asserted by prose in docs/integration-contract.md.

This test drives the REAL seam: it feeds raw JSON `value` payloads (exactly as
they arrive from Kafka) through `parse_positions()` and then `detect_red_points()`.

Run:  python tests/test_position_parsing.py
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# CELL_SIZE is read at import time by the detector module; pin it (hard set, so an
# exported value can't win) to keep the cell math deterministic regardless of env.
os.environ["CELL_SIZE"] = "100"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from pyspark.sql import SparkSession

from red_point_detector import MIN_STATIONARY_AVATARS, detect_red_points, parse_positions

BASE_TIME = datetime(2026, 7, 7, 12, 0, 0, tzinfo=timezone.utc)


def iso_z(dt):
    """Reproduce JavaScript's Date.prototype.toISOString(): millis + trailing Z."""
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def raw_value_rows():
    """Six avatars stopped in the same cell, three samples each, 10 s apart.

    Emitted as raw JSON strings in a `value` column — exactly the shape the Kafka
    source hands to parse_positions(). avatar_id uses the real
    `${room}-${epoch}-${index}` format so any accidental coupling would surface.
    """
    rows = []
    for avatar in range(6):
        for sample in range(3):
            event = {
                "avatar_id": f"ECCI-1234-7-{avatar}",
                "x": -104.5,
                "y": 152.0,
                "speed": 0.1,
                "ts": iso_z(BASE_TIME + timedelta(seconds=10 * sample)),
                "room": "ECCI-1234",  # injected by the Node bridge envelope
            }
            rows.append((json.dumps(event),))
    return rows


def main():
    # Distrobox exports CONTAINER_ID, which Spark mistakes for a YARN container.
    os.environ.pop("CONTAINER_ID", None)

    spark = (
        SparkSession.builder.appName("test-position-parsing")
        .master("local[1]")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")

    try:
        raw = spark.createDataFrame(raw_value_rows(), "value string")
        parsed = parse_positions(raw)

        # 1) The ISO-8601 'Z' timestamp must parse — not silently become NULL.
        null_times = parsed.filter(parsed.event_time.isNull()).count()
        assert null_times == 0, (
            f"to_timestamp() failed on JS ISO-8601 'Z' timestamps: "
            f"{null_times} rows got a NULL event_time (the detector would go dark)"
        )

        # 2) The parsed fields must feed detection and flag the red point.
        reds = detect_red_points(parsed).collect()
        assert len(reds) >= 1, "expected a red point from 6 stationary avatars, got none"
        assert reds[0]["stationary_avatars"] >= MIN_STATIONARY_AVATARS, (
            f"stationary_avatars {reds[0]['stationary_avatars']} "
            f"below threshold {MIN_STATIONARY_AVATARS}"
        )

        print("OK - JS producer -> Spark parsing seam verified (ISO-8601 'Z' ts parses, detection fires)")
    finally:
        spark.stop()


if __name__ == "__main__":
    main()

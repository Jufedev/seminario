"""Unit test for the red-point detection logic — no Kafka or Docker required.

Runs the same detect_red_points() used by the streaming job against a static
(batch) DataFrame with three synthetic scenarios:

  1. 6 avatars stopped in the same cell        -> MUST be flagged as red point
  2. 4 avatars stopped in another cell         -> below threshold, NOT flagged
  3. 5 avatars moving fast through a third cell -> not stationary, NOT flagged

Run:  python tests/test_detection_logic.py
Needs: pip install pyspark==3.5.1 and Java 17.
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from pyspark.sql import SparkSession

from red_point_detector import detect_red_points

BASE_TIME = datetime(2026, 7, 1, 12, 0, 0)


def make_samples(avatar_prefix, count, x, y, speed, samples=3):
    """Emit `samples` readings per avatar, 10 seconds apart, at a fixed spot."""
    rows = []
    for i in range(count):
        for s in range(samples):
            rows.append(
                (
                    f"{avatar_prefix}-{i:02d}",
                    x + i * 2.0,  # small spread, stays inside the same 100x100 cell
                    y,
                    speed,
                    BASE_TIME + timedelta(seconds=10 * s),
                )
            )
    return rows


def main() -> None:
    # See red_point_detector.main(): Distrobox's CONTAINER_ID makes Spark
    # assume a YARN container. Remove it before the JVM starts.
    os.environ.pop("CONTAINER_ID", None)

    spark = (
        SparkSession.builder.appName("test-red-point-detection")
        .master("local[2]")
        .config("spark.sql.shuffle.partitions", "2")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")

    rows = (
        make_samples("stuck", count=6, x=510.0, y=505.0, speed=0.0)  # cell (5,5)
        + make_samples("few", count=4, x=110.0, y=120.0, speed=0.0)  # cell (1,1)
        + make_samples("moving", count=5, x=710.0, y=705.0, speed=15.0)  # cell (7,7)
    )
    positions = spark.createDataFrame(
        rows, schema="avatar_id string, x double, y double, speed double, event_time timestamp"
    )

    result = detect_red_points(positions).collect()
    flagged_cells = {(r["cell_x"], r["cell_y"]) for r in result}

    assert (5, 5) in flagged_cells, (
        f"Expected cell (5,5) with 6 stationary avatars to be flagged, got {flagged_cells}"
    )
    assert (1, 1) not in flagged_cells, (
        "Cell (1,1) has only 4 stationary avatars (threshold is 5) and must NOT be flagged"
    )
    assert (7, 7) not in flagged_cells, (
        "Cell (7,7) has moving avatars only and must NOT be flagged"
    )
    for r in result:
        assert r["stationary_avatars"] >= 5, f"Flagged row below threshold: {r}"

    print("OK — detection logic behaves as expected:")
    print(f"  flagged cells: {sorted(flagged_cells)}")
    print(f"  windows emitted for cell (5,5): {sum(1 for r in result if (r['cell_x'], r['cell_y']) == (5, 5))}")

    spark.stop()


if __name__ == "__main__":
    main()

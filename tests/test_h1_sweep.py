"""Integration test for the H1 window sweep — needs Spark (pyspark 3.5.1 + Java 17).

Replays detect_red_points over one synthetic run at three window configurations
and checks the detection latency against the hand-computed ground truth. The three
configs are chosen to pin two real findings, not just to pass:

  jam: 6 avatars stopped 15 s in cell (4,5); N=5 avatars, D=5 s mean dwell.
  ground-truth onset: mean dwell hits 5 s at t=4 s  -> onset = BASE + 4 s.

  1. window 10 s / slide  5 s -> first window ending at BASE+5 s flags it
                                 -> latency 1 s   (fine slide detects sooner)
  2. window 10 s / slide 10 s -> first window ending at BASE+10 s flags it
                                 -> latency 6 s   (coarse slide detects later:
                                    the slide is the algorithmic-latency floor)
  3. window  3 s / slide  3 s -> a 3 s window holds at most 3 samples/avatar, so
                                 mean dwell can never reach 5 s -> MISSED
                                 (a window shorter than the dwell cannot detect)

A traffic light (8 avatars, 2 s each) in another cell must never be flagged, so it
is neither a latency nor a false positive.

Run:  python tests/test_h1_sweep.py
"""

import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

# Pin the whole process to UTC BEFORE Spark starts: collect() converts timestamps
# through the driver's local zone, so UTC here + session UTC below keeps window_end
# and the onset in one frame (mirrors the production detector's UTC pinning).
os.environ["TZ"] = "UTC"
time.tzset()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

from h1_measurement import sweep_latency

BASE = datetime(2026, 7, 1, 12, 0, 0)
GRID = dict(cell_size_x=30.0, cell_size_y=30.0, grid_origin_x=-240.0, grid_origin_y=-195.0)
ROOM = "ECCI-TEST"


def rows(prefix, count, x, y, speed, n):
    out = []
    for i in range(count):
        for s in range(n):
            out.append((f"{prefix}-{i:02d}", x + i * 2.0, y, speed, BASE + timedelta(seconds=s), ROOM))
    return out


def main() -> None:
    os.environ.pop("CONTAINER_ID", None)  # Distrobox: Spark mistakes it for YARN
    spark = (
        SparkSession.builder.appName("test-h1-sweep")
        .master("local[2]")
        .config("spark.sql.shuffle.partitions", "2")
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")

    data = (
        rows("jam", count=6, x=-105.0, y=-30.0, speed=0.0, n=15)   # cell (4,5)
        + rows("light", count=8, x=105.0, y=30.0, speed=0.0, n=2)  # cell (11,7), 2 s dwell
    )
    positions = spark.createDataFrame(
        data, schema="avatar_id string, x double, y double, speed double, event_time timestamp, room string"
    )

    results = sweep_latency(
        positions,
        window_configs=[("10 seconds", "5 seconds"), ("10 seconds", "10 seconds"), ("3 seconds", "3 seconds")],
        min_avatars=5,
        min_dwell_s=5.0,
        speed_threshold=0.5,
        **GRID,
    )
    by_window = {(r["window_duration"], r["window_slide"]): r for r in results}
    jam = (ROOM, 4, 5)

    fine = by_window[("10 seconds", "5 seconds")]
    assert fine["latencies_s"] == {jam: 1.0}, f"fine slide: expected jam latency 1 s, got {fine['latencies_s']}"
    assert fine["false_positives"] == [], f"traffic light must not be a false positive, got {fine['false_positives']}"
    assert fine["missed"] == [], f"jam must be detected at 10/5, got missed {fine['missed']}"
    print(f"OK — window 10 s / slide  5 s: jam detected {fine['latencies_s'][jam]} s after onset")

    coarse = by_window[("10 seconds", "10 seconds")]
    assert coarse["latencies_s"] == {jam: 6.0}, f"coarse slide: expected jam latency 6 s, got {coarse['latencies_s']}"
    print(f"OK — window 10 s / slide 10 s: jam detected {coarse['latencies_s'][jam]} s after onset (coarser slide, later)")

    short = by_window[("3 seconds", "3 seconds")]
    assert short["latencies_s"] == {}, f"a 3 s window cannot reach a 5 s dwell, got {short['latencies_s']}"
    assert short["missed"] == [jam], f"jam must be MISSED at window 3 s < dwell 5 s, got missed {short['missed']}"
    print("OK — window 3 s < dwell 5 s: jam MISSED (a window shorter than the dwell cannot detect)")

    # The finding, stated: a finer slide cuts detection latency (1 s vs 6 s), and
    # the window must be at least the dwell or nothing is ever detected.
    assert fine["latencies_s"][jam] < coarse["latencies_s"][jam], "finer slide must not detect later"
    print("\nAll H1 sweep tests passed — latency responds to the window as designed.")

    spark.stop()


if __name__ == "__main__":
    main()

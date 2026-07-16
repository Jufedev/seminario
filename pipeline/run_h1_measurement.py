"""H1 measurement runner — turn one archived run into the detection-latency curve.

Reads the archived avatar-positions (Parquet, written by red_point_detector.py
when ARCHIVE_PATH is set), replays detect_red_points at several window durations,
and reports the detection latency of each against the ground-truth onset, plus
false positives and misses. One archived run yields every point on the curve.

The detection thresholds (avatars, dwell, grid, speed) come from the environment,
so the measurement uses the SAME calibration the deployed detector runs with. The
window sweep is this script's own list — the window is the experimental variable.

Usage (from the repo root, with the env profile loaded so the calibration matches):
    set -a; . ./.env; set +a
    .venv/bin/python pipeline/run_h1_measurement.py [--archive PATH] [--csv OUT.csv]

Needs pyspark 3.5.1 + Java 17 (same as the detector).
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Pin the process to UTC before Spark starts: collect() converts timestamps
# through the driver's local zone, and the detector emits window_end as UTC. UTC
# here + session UTC below keeps window_end and the onset in one time frame.
os.environ["TZ"] = "UTC"
time.tzset()

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pyspark.sql import SparkSession

from h1_measurement import sweep_latency

# The window durations to sweep (slide fixed at the calibrated 5 s). Each must be
# at least the mean-dwell threshold, or no window can ever reach it. The default
# calibrated window (10 s) sits in the middle so the curve brackets it.
DEFAULT_WINDOWS = [
    ("5 seconds", "5 seconds"),
    ("10 seconds", "5 seconds"),
    ("15 seconds", "5 seconds"),
    ("20 seconds", "5 seconds"),
    ("30 seconds", "5 seconds"),
]


def _f(name, default):
    return float(os.getenv(name, default))


def main() -> None:
    ap = argparse.ArgumentParser(description="H1 detection-latency sweep over an archived run.")
    ap.add_argument("--archive", default=os.getenv("ARCHIVE_PATH", "./archive"),
                    help="Parquet dir written by the detector (default: $ARCHIVE_PATH or ./archive)")
    ap.add_argument("--csv", default="h1_latency.csv", help="where to write the results table")
    ap.add_argument("--room", default=None,
                    help="measure only this room (a mixed archive of several runs pollutes the "
                         "cumulative ground truth; one room = one clean run)")
    args = ap.parse_args()

    if not Path(args.archive).exists():
        sys.exit(f"archive not found: {args.archive}\n"
                 f"Run the stack with ARCHIVE_PATH set and generate a jam first.")

    os.environ.pop("CONTAINER_ID", None)  # Distrobox: Spark mistakes it for YARN
    spark = (
        SparkSession.builder.appName("h1-measurement")
        .master("local[*]")
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")

    positions = spark.read.parquet(args.archive)
    if args.room:
        positions = positions.filter(positions.room == args.room)
    n = positions.count()
    if n == 0:
        sys.exit("the archive is empty — no positions were captured. Was a simulation running?")
    rooms = [r["room"] for r in positions.select("room").distinct().collect()]
    tmin, tmax = positions.selectExpr("min(event_time)", "max(event_time)").first()
    print(f"Archive: {n} position samples, rooms={rooms}, span {tmin} .. {tmax}\n")

    # Detection calibration from the environment (same as the deployed detector).
    params = dict(
        min_avatars=int(os.getenv("MIN_STATIONARY_AVATARS", "7")),
        min_dwell_s=_f("MIN_MEAN_DWELL_S", "5"),
        speed_threshold=_f("SPEED_THRESHOLD", "0.5"),
        cell_size_x=_f("CELL_SIZE_X", "30"),
        cell_size_y=_f("CELL_SIZE_Y", "30"),
        grid_origin_x=_f("GRID_ORIGIN_X", "-240"),
        grid_origin_y=_f("GRID_ORIGIN_Y", "-195"),
    )
    print(f"Calibration: avatars>={params['min_avatars']}, dwell>={params['min_dwell_s']}s, "
          f"speed<{params['speed_threshold']}, cell {params['cell_size_x']}x{params['cell_size_y']} "
          f"@ ({params['grid_origin_x']},{params['grid_origin_y']})\n")

    results = sweep_latency(positions, DEFAULT_WINDOWS, **params)

    # Report: the curve. mean_latency_s is the append-equivalent detection latency
    # (window-close), an upper bound on the live update-mode detector.
    header = f"{'window':>10} {'slide':>7} {'mean_latency_s':>15} {'detected':>9} {'false_pos':>10} {'missed':>7}"
    print(header)
    print("-" * len(header))
    lines = ["window_duration,window_slide,mean_latency_s,detected,false_positives,missed"]
    for r in results:
        ml = "-" if r["mean_latency_s"] is None else f"{r['mean_latency_s']:.1f}"
        nd, nfp, nm = len(r["latencies_s"]), len(r["false_positives"]), len(r["missed"])
        print(f"{r['window_duration']:>10} {r['window_slide']:>7} {ml:>15} {nd:>9} {nfp:>10} {nm:>7}")
        lines.append(f"{r['window_duration']},{r['window_slide']},{ml},{nd},{nfp},{nm}")

    Path(args.csv).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nWrote {args.csv}")
    spark.stop()


if __name__ == "__main__":
    main()

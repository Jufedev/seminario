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
from pyspark.sql import functions as F

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
    ap.add_argument("--until", default=None, metavar="'YYYY-MM-DD HH:MM:SS'",
                    help="ignore samples after this event_time (UTC). The detector keeps "
                         "archiving while it runs, so an archive GROWS past the jam you meant "
                         "to measure; this bounds a capture after the fact and makes a past "
                         "result reproducible")
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
    all_rooms = sorted(r["room"] for r in positions.select("room").distinct().collect())
    if args.room:
        positions = positions.filter(positions.room == args.room)
    if args.until:
        positions = positions.filter(positions.event_time <= F.lit(args.until).cast("timestamp"))
    n = positions.count()
    if n == 0:
        # Two different failures, two different diagnoses: a room filter that matches
        # nothing is a typo, not an empty archive, and telling the researcher to go
        # check whether the simulation was running would send them to the wrong place.
        if args.room and all_rooms:
            sys.exit(f"no positions for room {args.room!r}. The archive holds: {', '.join(all_rooms)}")
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
    spark.stop()

    # Report: the curve. mean_latency_s is the append-equivalent detection latency
    # (window-close), an upper bound on the live update-mode detector.
    header = f"{'window':>10} {'slide':>7} {'mean_latency_s':>15} {'detected':>9} {'false_pos':>10} {'missed':>7}"
    print(header)
    print("-" * len(header))
    for r in results:
        ml = "-" if r["mean_latency_s"] is None else f"{r['mean_latency_s']:.1f}"
        nd, nfp, nm = len(r["latencies_s"]), len(r["false_positives"]), len(r["missed"])
        print(f"{r['window_duration']:>10} {r['window_slide']:>7} {ml:>15} {nd:>9} {nfp:>10} {nm:>7}")

    # Refuse to leave a result behind when nothing was measured. The check runs
    # BEFORE the write on purpose: an exit code is only seen by whoever looks, while
    # a file on disk outlives the run and gets picked up as a curve by whoever comes
    # next. A measurement of nothing filed as a result is the worst thing this script
    # can do, and the project's rule is to fail loudly rather than degrade in silence.
    #
    # The two ways of measuring nothing get two diagnoses, because they send you to
    # opposite places. Onsets exist but every window missed them: that is a REAL H1
    # finding — the detector cannot see this jam at any window we swept — and telling
    # the researcher to go capture another run would bury it.
    if all(r["mean_latency_s"] is None for r in results):
        any_onsets = any(r["missed"] for r in results)
        if any_onsets:
            n = max(len(r["missed"]) for r in results)
            sys.exit(
                f"\nMEASURED NOTHING, AND THAT IS A RESULT: the archive holds {n} genuine "
                "congestion onset(s), and NO swept window detected any of them.\n"
                "This is not a bad capture — it is H1 failing on this run. Do not re-capture "
                "to make it go away: widen the sweep, or report it.\n"
                f"(swept {', '.join(w for w, _ in DEFAULT_WINDOWS)})"
            )
        sys.exit(
            "\nMEASURED NOTHING: the archive holds positions but not a single congestion "
            "onset — no cell ever crossed the thresholds "
            f"(avatars>={params['min_avatars']}, dwell>={params['min_dwell_s']}s).\n"
            "There is nothing here to measure. Capture a run where red zones actually appeared."
        )

    # Provenance goes IN the file. The archive that produced these numbers is not
    # versioned (megabytes of Parquet, regenerable), and it GROWS while the detector
    # keeps running — so a curve read on its own, months later, cannot be tied back to
    # the capture that produced it, and re-running over a grown archive yields
    # different numbers that look like the thesis lying. These lines are what makes
    # the result checkable instead of merely quoted.
    lines = [
        f"# archive: {args.archive}",
        f"# rooms: {','.join(rooms)}",
        f"# span: {tmin} .. {tmax}",
        f"# samples: {n}",
        f"# calibration: avatars>={params['min_avatars']} dwell>={params['min_dwell_s']}s "
        f"speed<{params['speed_threshold']} cell={params['cell_size_x']}x{params['cell_size_y']}"
        f"@({params['grid_origin_x']},{params['grid_origin_y']})",
        "# mean_latency_s is window-close latency: an UPPER BOUND on the live update-mode detector",
        "window_duration,window_slide,mean_latency_s,detected,false_positives,missed",
    ]
    for r in results:
        ml = "-" if r["mean_latency_s"] is None else f"{r['mean_latency_s']:.1f}"
        nd, nfp, nm = len(r["latencies_s"]), len(r["false_positives"]), len(r["missed"])
        lines.append(f"{r['window_duration']},{r['window_slide']},{ml},{nd},{nfp},{nm}")

    Path(args.csv).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nWrote {args.csv}")


if __name__ == "__main__":
    main()

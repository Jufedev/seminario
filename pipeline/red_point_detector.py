"""Red-point detector — Spark Structured Streaming job.

Reads avatar position events from Kafka, groups stationary avatars by map
grid cell over a sliding time window, and emits a "red point" event when
enough avatars stay stopped in the same zone.

Runs unchanged against local Kafka and Azure Event Hubs (Kafka endpoint):
set EVENTHUBS_CONNECTION_STRING to switch to Azure.

Input  topic (avatar-positions): {"avatar_id","x","y","speed","ts","room"}
Output topic (red-points):       {"room","cell_x","cell_y","center_x","center_y",
                                  "stationary_avatars","mean_dwell_s",
                                  "window_start","window_end"}
"""

import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import DoubleType, StringType, StructField, StructType


def env(name: str, default: str = "") -> str:
    """Read an env var, tolerating shell-style quoting.

    Container Apps hands the environment to the process directly, so nothing
    quotes anything and this is a no-op there. It guards the case where these
    values reach the process through a SHELL instead — a `.env` file, a wrapper
    script, a CI runner — because there a value holding a space or a `;` has to
    be quoted or it breaks silently: `WINDOW_DURATION=10 seconds` splits into
    two words, and the Event Hubs connection string truncates at its first `;`.

    Stripping the quotes here makes the same value correct either way, and it
    costs nothing.
    """
    return os.getenv(name, default).strip().strip("\"'")


KAFKA_BOOTSTRAP = env("KAFKA_BOOTSTRAP", "localhost:9092")
INPUT_TOPIC = env("INPUT_TOPIC", "avatar-positions")
OUTPUT_TOPIC = env("OUTPUT_TOPIC", "red-points")
CHECKPOINT_DIR = env("CHECKPOINT_DIR", "./checkpoints/red-point-detector")

# Optional historical archiving (thesis: ADLS archiving). When set, the parsed
# avatar-positions feed is appended to Parquet at this path. Local dir in dev
# (e.g. ./archive), abfss://... ADLS path in prod. Empty -> archiving disabled.
ARCHIVE_PATH = env("ARCHIVE_PATH", "")

# Detection parameters — these are the tunable knobs of the hypothesis:
# a red point = at least MIN_STATIONARY_AVATARS distinct avatars below
# SPEED_THRESHOLD inside the same grid cell within a WINDOW_DURATION sliding
# window, AND a mean dwell of at least MIN_MEAN_DWELL_S seconds per avatar.
#
# The dwell requirement is what separates congestion from traffic lights: the
# distinct-avatar count is cumulative and monotonic within a window (it never
# decreases once a car has stopped there), so on its own it matches any
# intersection where 5 different cars briefly braked — i.e. every normal
# red-light cycle. Requiring the avatars to STAY stopped (samples ≈ seconds
# at the 1 Hz emit rate) excludes short light stops and flags only traffic
# that is genuinely stuck.
#
# The grid is defined per axis and anchored at an origin so it can tile the
# consumer's zone overlay exactly (metaverse/src/analytics/config.js: 30x30
# cells anchored mid-block at (-240,-195), 16x13 zones). A misaligned grid
# (square cells anchored at 0) makes each cell straddle two zone rows, so red
# zones light up next to the congestion instead of on it. CELL_SIZE is the
# square-cell fallback.
CELL_SIZE = float(env("CELL_SIZE", "100"))
CELL_SIZE_X = float(env("CELL_SIZE_X", str(CELL_SIZE)))
CELL_SIZE_Y = float(env("CELL_SIZE_Y", str(CELL_SIZE)))
GRID_ORIGIN_X = float(env("GRID_ORIGIN_X", "0"))
GRID_ORIGIN_Y = float(env("GRID_ORIGIN_Y", "0"))
SPEED_THRESHOLD = float(env("SPEED_THRESHOLD", "0.5"))
MIN_STATIONARY_AVATARS = int(env("MIN_STATIONARY_AVATARS", "5"))
# Avatars emit at 1 Hz, so stationary samples per avatar ≈ seconds stopped.
# Must exceed the simulator's 8 s traffic-light phase (LIGHT_PERIOD) so a
# normal light stop can never qualify — only genuinely stuck traffic does.
MIN_MEAN_DWELL_S = float(env("MIN_MEAN_DWELL_S", "12"))
# WINDOW_DURATION is the H1 experimental variable: it trades detection
# stability for how fast a cleared street stops re-emitting (worst case
# ~window + TTL after the congestion dissolves).
WINDOW_DURATION = env("WINDOW_DURATION", "30 seconds")
WINDOW_SLIDE = env("WINDOW_SLIDE", "10 seconds")
WATERMARK_DELAY = env("WATERMARK_DELAY", "30 seconds")

# When set, connects to Azure Event Hubs instead of local Kafka
EVENTHUBS_CONNECTION_STRING = env("EVENTHUBS_CONNECTION_STRING", "")

POSITION_SCHEMA = StructType(
    [
        StructField("avatar_id", StringType(), nullable=False),
        StructField("x", DoubleType(), nullable=False),
        StructField("y", DoubleType(), nullable=False),
        StructField("speed", DoubleType(), nullable=False),
        StructField("ts", StringType(), nullable=False),  # ISO-8601
        StructField("room", StringType(), nullable=True),  # room code from bridge envelope
    ]
)


def kafka_options(topic: str, for_sink: bool = False) -> dict:
    options = {"kafka.bootstrap.servers": KAFKA_BOOTSTRAP}
    if for_sink:
        options["topic"] = topic
    else:
        options["subscribe"] = topic
        options["startingOffsets"] = "latest"
        # Only relevant when a checkpoint survives longer than the broker's retention,
        # which in Azure is the normal case rather than an edge one: the detector is
        # stopped between demos, its checkpoint lives on ADLS, and Event Hubs drops
        # messages after its retention window. On the next start Spark would find its
        # committed offsets pointing at messages that no longer exist and — with the
        # default of true — refuse to start at all, right when it is needed.
        #
        # The data it would be "losing" is avatar positions from days ago. A detector
        # of live congestion has no use for them. Skip to the oldest offset that still
        # exists and carry on.
        options["failOnDataLoss"] = "false"
    if EVENTHUBS_CONNECTION_STRING:
        options.update(
            {
                "kafka.security.protocol": "SASL_SSL",
                "kafka.sasl.mechanism": "PLAIN",
                "kafka.sasl.jaas.config": (
                    "org.apache.kafka.common.security.plain.PlainLoginModule required "
                    'username="$ConnectionString" '
                    f'password="{EVENTHUBS_CONNECTION_STRING}";'
                ),
            }
        )
    return options


def parse_positions(raw):
    """Decode Kafka JSON payloads into typed position rows with event_time."""
    return (
        raw.selectExpr("CAST(value AS STRING) AS json")
        .select(F.from_json("json", POSITION_SCHEMA).alias("e"))
        .select("e.*")
        .withColumn("event_time", F.to_timestamp("ts"))
    )


def detect_red_points(
    positions,
    cell_size_x=None,
    cell_size_y=None,
    grid_origin_x=None,
    grid_origin_y=None,
    window_duration=None,
    window_slide=None,
    watermark_delay=None,
    min_stationary_avatars=None,
    min_mean_dwell_s=None,
    speed_threshold=None,
):
    """Core detection: stationary avatars grouped by map cell in a sliding window.

    Takes a DataFrame with (avatar_id, x, y, speed, event_time, room) and
    returns one row per (window, room, cell) where at least
    MIN_STATIONARY_AVATARS distinct avatars were below SPEED_THRESHOLD *and*
    stayed there: the mean dwell (stationary samples per avatar, ≈ seconds at
    the 1 Hz emit rate) must reach MIN_MEAN_DWELL_S, which excludes brief
    traffic-light stops. Grouping by room keeps simultaneous rooms from
    pooling their congestion; a null room forms a single group, which the
    server treats as global. Works on both streaming and batch DataFrames (the
    watermark is ignored in batch), which is what makes the logic unit-testable
    without Kafka.

    Every parameter defaults to the env-driven module constant, so the streaming
    job (which passes none) is unaffected. Tests pass the grid explicitly to stay
    hermetic; the H1 measurement passes `window_duration`/`window_slide` to sweep
    the detection window — the experimental variable — over one archived run
    without touching the deployed detector.
    """
    csx = CELL_SIZE_X if cell_size_x is None else cell_size_x
    csy = CELL_SIZE_Y if cell_size_y is None else cell_size_y
    ox = GRID_ORIGIN_X if grid_origin_x is None else grid_origin_x
    oy = GRID_ORIGIN_Y if grid_origin_y is None else grid_origin_y
    wdur = WINDOW_DURATION if window_duration is None else window_duration
    wslide = WINDOW_SLIDE if window_slide is None else window_slide
    wmark = WATERMARK_DELAY if watermark_delay is None else watermark_delay
    min_avatars = MIN_STATIONARY_AVATARS if min_stationary_avatars is None else min_stationary_avatars
    min_dwell = MIN_MEAN_DWELL_S if min_mean_dwell_s is None else min_mean_dwell_s
    speed = SPEED_THRESHOLD if speed_threshold is None else speed_threshold
    return (
        positions.filter(F.col("speed") < speed)
        .withWatermark("event_time", wmark)
        .groupBy(
            F.window("event_time", wdur, wslide).alias("w"),
            F.col("room"),
            F.floor((F.col("x") - ox) / csx).alias("cell_x"),
            F.floor((F.col("y") - oy) / csy).alias("cell_y"),
        )
        .agg(
            F.approx_count_distinct("avatar_id").alias("stationary_avatars"),
            F.count("*").alias("stationary_samples"),
        )
        .filter(F.col("stationary_avatars") >= min_avatars)
        .filter(
            (F.col("stationary_samples") / F.col("stationary_avatars"))
            >= min_dwell
        )
        .withColumn(
            "mean_dwell_s",
            F.round(F.col("stationary_samples") / F.col("stationary_avatars"), 1),
        )
    )


def main() -> None:
    # Distrobox/toolbox export CONTAINER_ID, which Spark interprets as running
    # inside a YARN container ("Yarn Local dirs can't be empty"). Remove it
    # before the JVM starts so local mode works inside dev containers.
    os.environ.pop("CONTAINER_ID", None)

    spark = (
        SparkSession.builder.appName("red-point-detector")
        .config(
            "spark.jars.packages",
            "org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.1",
        )
        .config("spark.sql.shuffle.partitions", "4")
        # Pin the session time zone to UTC so window_start/window_end render as UTC
        # regardless of the host clock. Without this, casting the window timestamps to
        # string uses the JVM's local zone: on a UTC host (the Azure container) that is
        # harmless, but on a local dev box in another zone the emitted window_end would be
        # wall-clock-local while the server's `ts` and every downstream consumer assume UTC.
        # The metaverse's red-point store parses window_end as UTC (redPoints.js), so a
        # non-UTC render would shift it by the host offset and mis-order it against reset
        # timestamps. UTC everywhere keeps the event-time contract unambiguous.
        .config("spark.sql.session.timeZone", "UTC")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("WARN")

    raw = (
        spark.readStream.format("kafka")
        .options(**kafka_options(INPUT_TOPIC))
        .load()
    )

    parsed = parse_positions(raw)

    red_points = detect_red_points(parsed).select(
        F.to_json(
            F.struct(
                F.col("room"),
                F.col("cell_x"),
                F.col("cell_y"),
                ((F.col("cell_x") + 0.5) * CELL_SIZE_X + GRID_ORIGIN_X).alias("center_x"),
                ((F.col("cell_y") + 0.5) * CELL_SIZE_Y + GRID_ORIGIN_Y).alias("center_y"),
                F.col("stationary_avatars"),
                F.col("mean_dwell_s"),
                F.col("w.start").cast("string").alias("window_start"),
                F.col("w.end").cast("string").alias("window_end"),
            )
        ).alias("value"),
        F.concat_ws("_", F.col("room"), F.col("cell_x"), F.col("cell_y")).alias("key"),
    )

    # "update" mode emits a red point as soon as the threshold is crossed
    # instead of waiting for the window to close (lower detection latency).
    # The same cell may be emitted more than once per window as the count
    # grows — consumers deduplicate by key (cell_x_cell_y).
    query = (
        red_points.writeStream.format("kafka")
        .options(**kafka_options(OUTPUT_TOPIC, for_sink=True))
        .option("checkpointLocation", CHECKPOINT_DIR)
        .outputMode("update")
        .start()
    )

    print(
        f"Red-point detector running: {INPUT_TOPIC} -> {OUTPUT_TOPIC} "
        f"(cell={CELL_SIZE_X}x{CELL_SIZE_Y} @ ({GRID_ORIGIN_X},{GRID_ORIGIN_Y}), "
        f"min_avatars={MIN_STATIONARY_AVATARS}, "
        f"min_mean_dwell={MIN_MEAN_DWELL_S}s, "
        f"window={WINDOW_DURATION}, slide={WINDOW_SLIDE})"
    )

    # Loud warning for the silent misalignment trap: origin (0,0) is the square-cell
    # fallback nobody calibrated to. The real calibration (origin -240,-195) is only
    # injected via env by the Makefile/deploy, so a bare `python red_point_detector.py`
    # runs with these defaults and paints red zones offset from the overlay, with no
    # error. Warn (do not exit) so whoever knows what they are doing can still run bare.
    if GRID_ORIGIN_X == 0 and GRID_ORIGIN_Y == 0:
        print(
            "\n"
            "  ########################################################################\n"
            "  #  WARNING: grid origin is at (0,0) — the UNCALIBRATED fallback.        #\n"
            "  #  This happens when the env profile was NOT loaded. Red zones will be  #\n"
            "  #  MISALIGNED from the metaverse overlay (real origin is -240,-195).    #\n"
            "  #  Run via `make detector`, or set GRID_ORIGIN_X/GRID_ORIGIN_Y and      #\n"
            "  #  CELL_SIZE_X/CELL_SIZE_Y before launching.                            #\n"
            "  ########################################################################\n"
        )

    # Optional historical archiving: append the raw parsed positions feed to
    # Parquet (local dir in dev, abfss:// ADLS path in prod). Env-driven, so the
    # same code archives locally or to ADLS with no change. Disabled when empty.
    if ARCHIVE_PATH:
        archive_checkpoint = env("ARCHIVE_CHECKPOINT_DIR", CHECKPOINT_DIR + "-archive")
        (
            parsed.writeStream.format("parquet")
            .option("path", ARCHIVE_PATH)
            .option("checkpointLocation", archive_checkpoint)
            .outputMode("append")
            .start()
        )
        print(f"Historical archiving: ON -> {ARCHIVE_PATH} (checkpoint {archive_checkpoint})")
    else:
        print("Historical archiving: OFF (set ARCHIVE_PATH to enable)")

    # Both streams run concurrently; block until either terminates instead of
    # awaiting only the red-points query (which would leave the archive stream
    # unwaited).
    spark.streams.awaitAnyTermination()


if __name__ == "__main__":
    main()

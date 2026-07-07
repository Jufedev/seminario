"""Red-point detector — Spark Structured Streaming job.

Reads avatar position events from Kafka, groups stationary avatars by map
grid cell over a sliding time window, and emits a "red point" event when
enough avatars stay stopped in the same zone.

Runs unchanged against local Kafka and Azure Event Hubs (Kafka endpoint):
set EVENTHUBS_CONNECTION_STRING to switch to Azure.

Input  topic (avatar-positions): {"avatar_id","x","y","speed","ts","room"}
Output topic (red-points):       {"room","cell_x","cell_y","center_x","center_y",
                                  "stationary_avatars","window_start","window_end"}
"""

import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import DoubleType, StringType, StructField, StructType

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")
INPUT_TOPIC = os.getenv("INPUT_TOPIC", "avatar-positions")
OUTPUT_TOPIC = os.getenv("OUTPUT_TOPIC", "red-points")
CHECKPOINT_DIR = os.getenv("CHECKPOINT_DIR", "./checkpoints/red-point-detector")

# Optional historical archiving (thesis: ADLS archiving). When set, the parsed
# avatar-positions feed is appended to Parquet at this path. Local dir in dev
# (e.g. ./archive), abfss://... ADLS path in prod. Empty -> archiving disabled.
ARCHIVE_PATH = os.getenv("ARCHIVE_PATH", "")

# Detection parameters — these are the tunable knobs of the hypothesis:
# a red point = at least MIN_STATIONARY_AVATARS with speed below
# SPEED_THRESHOLD inside the same CELL_SIZE x CELL_SIZE map cell,
# observed within a WINDOW_DURATION sliding window.
CELL_SIZE = float(os.getenv("CELL_SIZE", "100"))
SPEED_THRESHOLD = float(os.getenv("SPEED_THRESHOLD", "0.5"))
MIN_STATIONARY_AVATARS = int(os.getenv("MIN_STATIONARY_AVATARS", "5"))
WINDOW_DURATION = os.getenv("WINDOW_DURATION", "60 seconds")
WINDOW_SLIDE = os.getenv("WINDOW_SLIDE", "10 seconds")
WATERMARK_DELAY = os.getenv("WATERMARK_DELAY", "30 seconds")

# When set, connects to Azure Event Hubs instead of local Kafka
EVENTHUBS_CONNECTION_STRING = os.getenv("EVENTHUBS_CONNECTION_STRING", "")

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


def detect_red_points(positions):
    """Core detection: stationary avatars grouped by map cell in a sliding window.

    Takes a DataFrame with (avatar_id, x, y, speed, event_time, room) and
    returns one row per (window, room, cell) where at least
    MIN_STATIONARY_AVATARS distinct avatars were below SPEED_THRESHOLD.
    Grouping by room keeps simultaneous rooms from pooling their congestion;
    a null room (legacy messages) forms one group. Works on both streaming and
    batch
    DataFrames (the watermark is ignored in batch), which is what makes the
    logic unit-testable without Kafka.
    """
    return (
        positions.filter(F.col("speed") < SPEED_THRESHOLD)
        .withWatermark("event_time", WATERMARK_DELAY)
        .groupBy(
            F.window("event_time", WINDOW_DURATION, WINDOW_SLIDE).alias("w"),
            F.col("room"),
            F.floor(F.col("x") / CELL_SIZE).alias("cell_x"),
            F.floor(F.col("y") / CELL_SIZE).alias("cell_y"),
        )
        .agg(F.approx_count_distinct("avatar_id").alias("stationary_avatars"))
        .filter(F.col("stationary_avatars") >= MIN_STATIONARY_AVATARS)
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
                ((F.col("cell_x") + 0.5) * CELL_SIZE).alias("center_x"),
                ((F.col("cell_y") + 0.5) * CELL_SIZE).alias("center_y"),
                F.col("stationary_avatars"),
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
        f"(cell={CELL_SIZE}, min_avatars={MIN_STATIONARY_AVATARS}, "
        f"window={WINDOW_DURATION}, slide={WINDOW_SLIDE})"
    )

    # Optional historical archiving: append the raw parsed positions feed to
    # Parquet (local dir in dev, abfss:// ADLS path in prod). Env-driven, so the
    # same code archives locally or to ADLS with no change. Disabled when empty.
    if ARCHIVE_PATH:
        archive_checkpoint = os.getenv(
            "ARCHIVE_CHECKPOINT_DIR", CHECKPOINT_DIR + "-archive"
        )
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

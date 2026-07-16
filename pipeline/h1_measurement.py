"""H1 measurement — detection latency of the streaming detector.

The thesis hypothesis (H1) is that the streaming architecture detects a blockage
with enough lead time to reroute. Its dependent variable is the DETECTION LATENCY:

    L = detection_time - t_condition

- t_condition ("ground truth"): the first event-time instant the congestion
  genuinely EXISTS by the detector's own definition. It is NOT observable live —
  in that instant nobody knows it yet; it is exactly what the detector is trying
  to find. It is computed AFTERWARDS, by replaying the archived raw positions.

- detection_time: when the streaming detector reported the cell, taken from the
  earliest window that flags it (`window_end`) when detect_red_points is replayed
  over the same archive with a given window configuration.

Both are EVENT times, so L is deterministic and reproducible from one archived
run — no live experiment per data point. Sweeping the window duration over that
one archive yields the latency-vs-window curve, which is H1 measured instead of
argued.

This module holds the GROUND-TRUTH half, which is pure Python (no Spark): the
data of a single run is small, so replaying it on the driver is both simpler and
unit-testable without a JVM. The window sweep (which reuses detect_red_points,
a Spark op) lives alongside it.

Ground-truth definition (chosen deliberately, see the thesis): t_condition is the
first instant at which, looking at ALL stopped samples up to that instant
(cumulatively, with no window), the cell meets the detector's exact condition —
at least `min_avatars` distinct stopped avatars AND a mean dwell (stopped samples
per avatar) of at least `min_dwell_s`. It answers "when did the congestion really
begin", and the gap to when a window reports it IS the latency. The count is
EXACT here (a set), unlike the detector's approx_count_distinct — the reference
must be exact; the approximation is part of what we are measuring against it.
"""

import math
from collections import defaultdict, namedtuple

# One archived position reading. `event_time` is any orderable, equality-comparable
# value (a datetime in tests, a parsed timestamp from Parquet in production).
Sample = namedtuple("Sample", "room avatar_id x y speed event_time")


def cell_of(x, y, cell_size_x, cell_size_y, grid_origin_x, grid_origin_y):
    """Map a world coordinate to a grid cell, exactly as detect_red_points does.

    Uses floor toward -infinity (math.floor matches Spark's F.floor), so negative
    coordinates land in the same cell the detector would assign.
    """
    return (
        math.floor((x - grid_origin_x) / cell_size_x),
        math.floor((y - grid_origin_y) / cell_size_y),
    )


def ground_truth_onsets(
    samples,
    *,
    min_avatars,
    min_dwell_s,
    speed_threshold,
    cell_size_x,
    cell_size_y,
    grid_origin_x,
    grid_origin_y,
):
    """First event-time each cell genuinely satisfies the congestion definition.

    Returns a dict {(room, cell_x, cell_y): onset_event_time} holding, for every
    cell that ever qualifies, the earliest event_time at which the cumulative
    condition becomes true. Cells that never qualify (too few avatars, or only
    brief traffic-light stops) are absent — their absence is the ground truth
    that a detection there would be a FALSE POSITIVE.

    Pure and Spark-free: `samples` is any iterable of Sample. Only stopped
    samples (speed < speed_threshold) count, mirroring the detector's filter.
    """
    # Bucket stopped samples per cell, then walk each cell in time order.
    stopped_by_cell = defaultdict(list)  # (room, cx, cy) -> [(event_time, avatar_id)]
    for s in samples:
        if s.speed >= speed_threshold:
            continue  # moving avatars are not congestion, same as the detector
        cx, cy = cell_of(
            s.x, s.y, cell_size_x, cell_size_y, grid_origin_x, grid_origin_y
        )
        stopped_by_cell[(s.room, cx, cy)].append((s.event_time, s.avatar_id))

    onsets = {}
    for cell, rows in stopped_by_cell.items():
        rows.sort(key=lambda r: r[0])  # by event_time; 1 Hz emit => seconds
        distinct = set()
        n_samples = 0
        # The condition is monotonic (counts only grow), so the first row that
        # flips it true marks the onset — and that row's event_time is correct,
        # since every earlier and same-instant sample is already counted by then.
        for event_time, avatar_id in rows:
            distinct.add(avatar_id)
            n_samples += 1
            if len(distinct) >= min_avatars and n_samples / len(distinct) >= min_dwell_s:
                onsets[cell] = event_time
                break
    return onsets


def rows_to_samples(rows):
    """Adapt collected position Rows (or dicts) to Samples for the ground truth.

    The archived Parquet and the streaming feed share the same fields; this lets
    the same rows drive both the pure onset (here) and detect_red_points (Spark).
    """
    return [
        Sample(r["room"], r["avatar_id"], r["x"], r["y"], r["speed"], r["event_time"])
        for r in rows
    ]


def detection_times(red_point_rows):
    """Earliest window_end per cell, from collected detect_red_points output.

    Returns {(room, cell_x, cell_y): detection_time}. In batch there is no
    update-mode early emission, so the earliest window that flags a cell (its
    `window_end`) is the append-equivalent detection time — an UPPER BOUND on the
    live detector, which in update mode emits as soon as the threshold is crossed
    mid-window. Reporting the conservative number is deliberate.

    Reads the window struct `w.end` that detect_red_points returns (before the
    JSON projection the streaming sink applies).
    """
    out = {}
    for r in red_point_rows:
        cell = (r["room"], r["cell_x"], r["cell_y"])
        end = r["w"]["end"]
        if cell not in out or end < out[cell]:
            out[cell] = end
    return out


def sweep_latency(
    positions_df,
    window_configs,
    *,
    min_avatars,
    min_dwell_s,
    speed_threshold,
    cell_size_x,
    cell_size_y,
    grid_origin_x,
    grid_origin_y,
    watermark_delay="30 seconds",
):
    """The H1 experiment: detection latency vs window, over one archived run.

    For each (window_duration, window_slide) in `window_configs`, replays
    detect_red_points over the SAME positions and compares each detected cell's
    detection_time against its ground-truth onset. The onset is computed once
    (it does not depend on the window). Returns one summary dict per config:

        window_duration, window_slide,
        latencies_s     : {cell: detection_time - onset, in seconds},
        mean_latency_s  : mean over detected true cells (None if none),
        false_positives : cells flagged with NO onset (a light stop mis-called),
        missed          : cells with an onset the window never flagged.

    `positions_df` is a Spark DataFrame with (avatar_id, x, y, speed, event_time,
    room). The caller owns the session and MUST pin spark.sql.session.timeZone to
    UTC (as the production detector does), so window_end and the onset share one
    time frame and their difference is meaningful.

    detect_red_points is imported lazily so the pure onset above stays Spark-free.
    """
    from red_point_detector import detect_red_points

    grid = dict(
        cell_size_x=cell_size_x,
        cell_size_y=cell_size_y,
        grid_origin_x=grid_origin_x,
        grid_origin_y=grid_origin_y,
    )
    onsets = ground_truth_onsets(
        rows_to_samples(positions_df.collect()),
        min_avatars=min_avatars,
        min_dwell_s=min_dwell_s,
        speed_threshold=speed_threshold,
        **grid,
    )

    results = []
    for window_duration, window_slide in window_configs:
        flagged = detect_red_points(
            positions_df,
            window_duration=window_duration,
            window_slide=window_slide,
            watermark_delay=watermark_delay,
            min_stationary_avatars=min_avatars,
            min_mean_dwell_s=min_dwell_s,
            speed_threshold=speed_threshold,
            **grid,
        ).collect()
        detected = detection_times(flagged)

        latencies = {}
        false_positives = []
        for cell, detection_time in detected.items():
            onset = onsets.get(cell)
            if onset is None:
                false_positives.append(cell)
            else:
                latencies[cell] = (detection_time - onset).total_seconds()
        missed = [cell for cell in onsets if cell not in detected]

        results.append(
            {
                "window_duration": window_duration,
                "window_slide": window_slide,
                "latencies_s": latencies,
                "mean_latency_s": (sum(latencies.values()) / len(latencies)) if latencies else None,
                "false_positives": false_positives,
                "missed": missed,
            }
        )
    return results

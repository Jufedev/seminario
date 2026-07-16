"""Unit test for the H1 ground-truth onset — pure Python, no Spark or Java.

The onset t_condition is the reference against which detection latency is measured,
so its definition is pinned here with fixtures whose answer is computable by hand.

With N=5 distinct avatars and D=12 s mean dwell required: six avatars all stopped
from t=0, emitting 1 sample/s, reach a mean dwell of 12 s exactly at t=11 (each has
12 samples: 72 samples / 6 avatars = 12). So the onset is the event_time at t=11 s.

Run:  python tests/test_h1_measurement.py   (no dependencies beyond the stdlib)
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from h1_measurement import Sample, cell_of, ground_truth_onsets

BASE = datetime(2026, 7, 1, 12, 0, 0)

# Metaverse-calibrated grid (matches env/env.prod.example and the detector test).
GRID = dict(cell_size_x=30.0, cell_size_y=30.0, grid_origin_x=-240.0, grid_origin_y=-195.0)
PARAMS = dict(min_avatars=5, min_dwell_s=12.0, speed_threshold=0.5, **GRID)


def samples(prefix, count, x, y, speed, n, start=0):
    """`count` avatars at (x,y), each emitting `n` readings 1 s apart from `start`."""
    out = []
    for i in range(count):
        for s in range(n):
            out.append(
                Sample(
                    room="ECCI-TEST",
                    avatar_id=f"{prefix}-{i:02d}",
                    x=x + i * 2.0,  # small spread, stays in the same 30x30 cell
                    y=y,
                    speed=speed,
                    event_time=BASE + timedelta(seconds=start + s),
                )
            )
    return out


def main() -> None:
    # A stopped queue at Cra25 x Cl52 (x=-105, y=-30) -> cell (4,5), the same cell
    # the detector test asserts. Six avatars stuck 15 s.
    jam = samples("jam", count=6, x=-105.0, y=-30.0, speed=0.0, n=15)
    onsets = ground_truth_onsets(jam, **PARAMS)

    assert cell_of(-105.0, -30.0, **GRID) == (4, 5), "grid mapping drifted from the detector"
    assert ("ECCI-TEST", 4, 5) in onsets, f"the jam must have an onset, got {onsets}"
    onset = onsets[("ECCI-TEST", 4, 5)]
    expected = BASE + timedelta(seconds=11)  # mean dwell hits 12 s exactly at t=11
    assert onset == expected, f"onset must be t=11 s ({expected}), got {onset}"
    print(f"OK — jam onset at t=+{(onset - BASE).seconds}s (cell 4,5)")

    # Below the avatar threshold: 4 stuck avatars never qualify -> no onset.
    few = samples("few", count=4, x=-105.0, y=-30.0, speed=0.0, n=30)
    assert ground_truth_onsets(few, **PARAMS) == {}, "4 avatars are below the threshold"
    print("OK — 4 avatars: no onset (below avatar threshold)")

    # Moving avatars are not congestion -> no onset.
    moving = samples("mov", count=8, x=-105.0, y=-30.0, speed=15.0, n=30)
    assert ground_truth_onsets(moving, **PARAMS) == {}, "moving avatars are not stopped"
    print("OK — moving avatars: no onset")

    # Traffic light: 8 DISTINCT avatars but each braking only ~2 s. Distinct count
    # clears the threshold, but mean dwell (2 s) never reaches 12 s -> NO onset.
    # This is the regression that separates congestion from a normal light cycle;
    # if the ground truth flagged it, every intersection would be a false negative
    # for the detector (a "real" congestion the detector rightly ignores).
    light = samples("light", count=8, x=-105.0, y=-30.0, speed=0.0, n=2)
    assert ground_truth_onsets(light, **PARAMS) == {}, (
        "8 avatars braking 2 s each must NOT have an onset — mean dwell is 2 s, "
        "far below 12 s. This is congestion vs. traffic-light, at the ground-truth level."
    )
    print("OK — traffic light (8 avatars, 2 s each): no onset")

    # Two rooms with the same cell stay independent (the detector groups by room).
    two = (
        samples("a", count=6, x=-105.0, y=-30.0, speed=0.0, n=15)
        + [s._replace(room="ECCI-OTHER") for s in samples("b", count=6, x=-105.0, y=-30.0, speed=0.0, n=15)]
    )
    keys = set(ground_truth_onsets(two, **PARAMS).keys())
    assert keys == {("ECCI-TEST", 4, 5), ("ECCI-OTHER", 4, 5)}, f"rooms must not pool, got {keys}"
    print("OK — two rooms in the same cell stay independent")

    print("\nAll H1 ground-truth onset tests passed.")


if __name__ == "__main__":
    main()

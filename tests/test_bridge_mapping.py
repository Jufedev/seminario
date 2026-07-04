"""Unit test for the bridge schema mapping — no Kafka, Spark or websockets required.

Exercises backend/mapping.py (pure stdlib) in three groups:

  1. Metaverse 'agent.position' envelope -> detector input schema
     (field mapping, x/z -> x/y coordinates, epoch-ms -> ISO-8601 UTC,
      avatar_id derivation with session short hash)
  2. Detector 'red-points' record -> WebSocket 'zone.red' message
     (inverse coordinate mapping y -> z, cell metadata)
  3. Malformed and unknown-topic inputs -> None (ignored gracefully)

Run:  python3 tests/test_bridge_mapping.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.mapping import (
    epoch_ms_to_iso,
    map_agent_position,
    map_red_point,
    session_short_hash,
)

SESSION = "3f9c2a71-8f2e-4c14-9d4d-0a1b2c3d4e5f"


def make_envelope(**overrides):
    """A well-formed per-avatar 'agent.position' envelope as producer.js emits it."""
    envelope = {
        "topic": "agent.position",
        "session_id": SESSION,
        "ts": 1751630400000,  # 2025-07-04T12:00:00Z
        "agent_id": 42,
        "x": -104.5,
        "z": 152.0,
        "speed_mps": 3.25,
    }
    envelope.update(overrides)
    return envelope


def test_position_mapping() -> None:
    mapped = map_agent_position(make_envelope())
    assert mapped is not None, "Well-formed envelope must be mappable"

    assert set(mapped) == {"avatar_id", "x", "y", "speed", "ts"}, (
        f"Pipeline schema mismatch: {sorted(mapped)}"
    )
    # Coordinate mapping: world x passes through, ground-plane z becomes y
    assert mapped["x"] == -104.5
    assert mapped["y"] == 152.0
    assert mapped["speed"] == 3.25
    # epoch-ms -> ISO-8601 UTC
    assert mapped["ts"] == "2025-07-04T12:00:00.000+00:00", mapped["ts"]

    # avatar_id: deterministic session short hash + agent id
    prefix = session_short_hash(SESSION)
    assert mapped["avatar_id"] == f"{prefix}-42", mapped["avatar_id"]
    assert len(prefix) == 8

    # Same session -> same prefix; different session -> different avatar_id
    again = map_agent_position(make_envelope())
    assert again["avatar_id"] == mapped["avatar_id"], "Mapping must be deterministic"
    other = map_agent_position(make_envelope(session_id="another-session"))
    assert other["avatar_id"] != mapped["avatar_id"], (
        "Same agent_id in different sessions must yield distinct avatar_ids"
    )

    # Negative coordinates are valid world units (no normalization)
    negative = map_agent_position(make_envelope(x=-180.0, z=-80.0))
    assert negative["x"] == -180.0 and negative["y"] == -80.0

    # Missing session_id: falls back to the bare agent id
    bare = map_agent_position(make_envelope(session_id=None))
    assert bare["avatar_id"] == "42"

    print("OK - position envelope -> pipeline schema")


def test_iso_conversion() -> None:
    assert epoch_ms_to_iso(0) == "1970-01-01T00:00:00.000+00:00"
    assert epoch_ms_to_iso(1751630400123) == "2025-07-04T12:00:00.123+00:00"
    print("OK - epoch-ms -> ISO-8601 UTC conversion")


def test_red_point_mapping() -> None:
    record = {
        "cell_x": -3,
        "cell_y": 2,
        "center_x": -95.0,
        "center_y": 95.0,
        "stationary_avatars": 7,
        "window_start": "2025-07-04 12:00:00",
        "window_end": "2025-07-04 12:01:00",
    }
    message = map_red_point(record, cell_size=38.0)
    assert message is not None

    assert message["topic"] == "zone.red"
    assert message["source"] == "pipeline"
    # Inverse coordinate mapping: detector y -> metaverse world z
    assert message["center_x"] == -95.0
    assert message["center_z"] == 95.0
    assert "center_y" not in message
    assert message["cell_x"] == -3 and message["cell_y"] == 2
    assert message["cell_size"] == 38.0
    assert message["stationary_avatars"] == 7
    assert message["window_start"] == "2025-07-04 12:00:00"
    assert message["window_end"] == "2025-07-04 12:01:00"

    # cell_size is optional (omitted when not provided)
    without = map_red_point(record)
    assert "cell_size" not in without

    print("OK - red-point record -> WebSocket zone.red message")


def test_malformed_and_unknown_inputs() -> None:
    # Unknown/other metaverse topics are not mappable
    assert map_agent_position({"topic": "agent.spawn", "agent_id": 1}) is None
    assert map_agent_position({"topic": "incident.start", "ts": 123}) is None

    # Legacy AGGREGATE agent.position sample (no agent_id/x/z) must be ignored
    aggregate = {
        "topic": "agent.position",
        "session_id": SESSION,
        "ts": 1751630400000,
        "sampled_at": 1751630400000,
        "moving": 80,
        "waiting": 15,
        "stuck": 5,
        "arrived": 10,
        "avg_speed_mps": 9.4,
    }
    assert map_agent_position(aggregate) is None

    # Missing or non-numeric fields
    assert map_agent_position(make_envelope(x=None)) is None
    assert map_agent_position(make_envelope(z="152")) is None
    assert map_agent_position(make_envelope(speed_mps=float("nan"))) is None
    assert map_agent_position(make_envelope(ts=0)) is None
    assert map_agent_position(make_envelope(agent_id=True)) is None

    # Numeric ts outside the representable datetime range must not raise
    assert map_agent_position(make_envelope(ts=1e18)) is None
    assert map_agent_position(make_envelope(ts=-1e18)) is None

    # Not even a dict / empty
    assert map_agent_position(None) is None
    assert map_agent_position("agent.position") is None
    assert map_agent_position({}) is None

    # Malformed red-point records
    assert map_red_point(None) is None
    assert map_red_point([1, 2, 3]) is None
    assert map_red_point({"cell_x": 1, "cell_y": 2}) is None
    assert map_red_point(
        {"cell_x": 1, "cell_y": 2, "center_x": "a", "center_y": 5.0, "stationary_avatars": 5}
    ) is None

    print("OK - malformed and unknown-topic inputs are ignored (None)")


def main() -> None:
    test_position_mapping()
    test_iso_conversion()
    test_red_point_mapping()
    test_malformed_and_unknown_inputs()
    print("OK - all bridge mapping tests passed")


if __name__ == "__main__":
    main()

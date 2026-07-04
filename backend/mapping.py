"""Pure translation between metaverse events and pipeline schemas.

This module is intentionally dependency-free (stdlib only) so it can be
imported and unit-tested without confluent_kafka or websockets installed.

Inbound (browser -> pipeline):
    Metaverse 'agent.position' envelope (per-avatar, emitted at ~1 Hz):
        {"topic": "agent.position", "session_id": "<uuid>", "ts": <epoch_ms>,
         "agent_id": <int>, "x": <world_x>, "z": <world_z>, "speed_mps": <float>}
    maps to the detector input schema (topic avatar-positions):
        {"avatar_id": "<hash8>-<agent_id>", "x": <float>, "y": <float>,
         "speed": <float m/s>, "ts": "<ISO-8601 UTC>"}

    Coordinate convention: the metaverse moves avatars on the Three.js ground
    plane (x, z); the detector works on a flat (x, y) grid. World x passes
    through unchanged and world z becomes detector y. Units are real world
    units (1 unit = 4 m in the metaverse map); no normalization is applied,
    so negative coordinates are valid (floor() yields negative cells).

    Note: the legacy aggregate 'agent.position' sample (moving/waiting/stuck
    counters, no agent_id) is NOT mappable and returns None on purpose.

Outbound (pipeline -> browser):
    Detector output record (topic red-points):
        {"cell_x", "cell_y", "center_x", "center_y", "stationary_avatars",
         "window_start", "window_end"}
    maps to the WebSocket message broadcast to browsers:
        {"topic": "zone.red", "source": "pipeline", "cell_x", "cell_y",
         "center_x": <world_x>, "center_z": <world_z>, "stationary_avatars",
         "window_start", "window_end"[, "cell_size"]}
    Inverse coordinate mapping: detector y becomes world z.

The recommended detector CELL_SIZE for the metaverse map is documented in
docs/integration-contract.md (it is an env var on the detector, not code).
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timezone

POSITION_TOPIC = "agent.position"
RED_ZONE_TOPIC = "zone.red"
RED_ZONE_SOURCE = "pipeline"


def _is_number(value) -> bool:
    """True for real, finite numbers (bool is excluded on purpose)."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def session_short_hash(session_id) -> str:
    """Deterministic 8-char hash of a session id, to keep avatar ids unique
    across browser sessions without leaking the full session UUID."""
    return hashlib.sha1(str(session_id).encode("utf-8")).hexdigest()[:8]


def epoch_ms_to_iso(epoch_ms) -> str:
    """Convert epoch milliseconds to an ISO-8601 UTC timestamp string."""
    return datetime.fromtimestamp(epoch_ms / 1000.0, tz=timezone.utc).isoformat(
        timespec="milliseconds"
    )


def map_agent_position(envelope) -> dict | None:
    """Map a per-avatar 'agent.position' envelope to the detector input schema.

    Returns None for anything that is not a well-formed per-avatar position
    event: other topics, the legacy aggregate sample (no agent_id/x/z), or
    envelopes with missing/non-numeric fields. Callers treat None as
    "ignore this event".
    """
    if not isinstance(envelope, dict):
        return None
    if envelope.get("topic") != POSITION_TOPIC:
        return None

    agent_id = envelope.get("agent_id")
    x = envelope.get("x")
    z = envelope.get("z")
    speed = envelope.get("speed_mps")
    ts = envelope.get("ts")

    if not _is_number(agent_id) or not _is_number(x) or not _is_number(z):
        return None
    if not _is_number(speed) or not _is_number(ts) or ts <= 0:
        return None

    try:
        ts_iso = epoch_ms_to_iso(ts)
    except (ValueError, OverflowError, OSError):
        # ts is numeric but outside the representable datetime range
        return None

    session_id = envelope.get("session_id")
    if session_id:
        avatar_id = f"{session_short_hash(session_id)}-{int(agent_id)}"
    else:
        avatar_id = str(int(agent_id))

    return {
        "avatar_id": avatar_id,
        "x": float(x),
        "y": float(z),  # Three.js ground-plane z -> detector y
        "speed": float(speed),
        "ts": ts_iso,
    }


def map_red_point(record, cell_size=None) -> dict | None:
    """Map a detector 'red-points' record to the WebSocket broadcast message.

    Applies the inverse coordinate mapping (detector y -> world z) so the
    browser can locate the red zone in metaverse world space. Returns None
    for malformed records.
    """
    if not isinstance(record, dict):
        return None

    cell_x = record.get("cell_x")
    cell_y = record.get("cell_y")
    center_x = record.get("center_x")
    center_y = record.get("center_y")
    stationary = record.get("stationary_avatars")

    for value in (cell_x, cell_y, center_x, center_y, stationary):
        if not _is_number(value):
            return None

    message = {
        "topic": RED_ZONE_TOPIC,
        "source": RED_ZONE_SOURCE,
        "cell_x": int(cell_x),
        "cell_y": int(cell_y),
        "center_x": float(center_x),
        "center_z": float(center_y),  # detector y -> Three.js ground-plane z
        "stationary_avatars": int(stationary),
        "window_start": record.get("window_start"),
        "window_end": record.get("window_end"),
    }
    if _is_number(cell_size) and cell_size > 0:
        message["cell_size"] = float(cell_size)
    return message

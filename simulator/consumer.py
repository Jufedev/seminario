"""Red-point consumer — placeholder for the metaverse backend.

Subscribes to the red-points topic and prints each detected blockage.
In the real system, the Three.js backend consumes this topic and pushes
the event to the browser via WebSocket to trigger route recalculation.

Deduplicates by cell key: the detector (update mode) may emit the same
cell several times as the stationary count grows within a window.
"""

import json
import os

from confluent_kafka import Consumer

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")
TOPIC = os.getenv("OUTPUT_TOPIC", "red-points")


def main() -> None:
    consumer = Consumer(
        {
            "bootstrap.servers": KAFKA_BOOTSTRAP,
            "group.id": "metaverse-backend",
            "auto.offset.reset": "latest",
        }
    )
    consumer.subscribe([TOPIC])
    print(f"Listening for red points on '{TOPIC}'...")

    seen_cells = set()
    try:
        while True:
            msg = consumer.poll(timeout=1.0)
            if msg is None or msg.error():
                continue
            event = json.loads(msg.value())
            cell = (event["cell_x"], event["cell_y"])
            is_new = cell not in seen_cells
            seen_cells.add(cell)
            tag = "NEW RED POINT" if is_new else "update       "
            print(
                f"[{tag}] cell={cell} center=({event['center_x']}, {event['center_y']}) "
                f"stationary_avatars={event['stationary_avatars']} "
                f"window={event['window_start']} -> {event['window_end']}"
            )
            if is_new:
                # Integration point: here the real backend would notify
                # the Three.js client to recalculate routes.
                pass
    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()


if __name__ == "__main__":
    main()

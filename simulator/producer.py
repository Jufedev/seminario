"""Avatar position simulator — Kafka producer.

Stand-in for the Three.js metaverse backend: simulates N avatars (cars)
driving from point A to point B and publishes one position event per avatar
per second to the avatar-positions topic.

At BLOCKAGE_START_S seconds a blockage zone activates at the route midpoint:
avatars entering it stop (speed 0), which builds up the stationary cluster
the Spark job must detect as a red point.

Event schema: {"avatar_id","x","y","speed","ts"}
"""

import json
import math
import os
import random
import time
from datetime import datetime, timezone

from confluent_kafka import Producer

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")
TOPIC = os.getenv("INPUT_TOPIC", "avatar-positions")

AVATAR_COUNT = int(os.getenv("AVATAR_COUNT", "50"))
POINT_A = (0.0, 0.0)
POINT_B = (1000.0, 1000.0)
BASE_SPEED = float(os.getenv("BASE_SPEED", "15.0"))  # map units per second

BLOCKAGE_START_S = int(os.getenv("BLOCKAGE_START_S", "20"))
BLOCKAGE_CENTER = (500.0, 500.0)
BLOCKAGE_RADIUS = float(os.getenv("BLOCKAGE_RADIUS", "60.0"))


class Avatar:
    def __init__(self, avatar_id: str):
        self.avatar_id = avatar_id
        self.x, self.y = POINT_A
        self.speed = BASE_SPEED * random.uniform(0.8, 1.2)
        # Stagger departures so avatars arrive at the blockage over time
        self.departure_delay = random.uniform(0, 30)
        self.stuck = False
        self.arrived = False

    def tick(self, elapsed: float, blockage_active: bool, dt: float) -> None:
        if self.stuck or self.arrived or elapsed < self.departure_delay:
            return
        if blockage_active and self._distance_to(BLOCKAGE_CENTER) <= BLOCKAGE_RADIUS:
            self.stuck = True
            return
        dx, dy = POINT_B[0] - self.x, POINT_B[1] - self.y
        remaining = math.hypot(dx, dy)
        step = self.speed * dt
        if remaining <= step:
            self.x, self.y = POINT_B
            self.arrived = True
            return
        self.x += dx / remaining * step
        self.y += dy / remaining * step

    def _distance_to(self, point) -> float:
        return math.hypot(self.x - point[0], self.y - point[1])

    def is_active(self, elapsed: float) -> bool:
        """The avatar exists in the world: it departed and has not arrived.

        Inactive avatars emit no telemetry — cars waiting to spawn at A (or
        despawned at B) would otherwise pile up as stationary clusters and
        trigger false red points at the route endpoints.
        """
        return elapsed >= self.departure_delay and not self.arrived

    def current_speed(self) -> float:
        return 0.0 if self.stuck else self.speed

    def to_event(self) -> dict:
        return {
            "avatar_id": self.avatar_id,
            "x": round(self.x, 2),
            "y": round(self.y, 2),
            "speed": round(self.current_speed(), 2),
            "ts": datetime.now(timezone.utc).isoformat(),
        }


def main() -> None:
    producer = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP})
    avatars = [Avatar(f"av-{i:03d}") for i in range(AVATAR_COUNT)]
    start = time.monotonic()
    print(
        f"Simulating {AVATAR_COUNT} avatars -> topic '{TOPIC}' "
        f"(blockage at t={BLOCKAGE_START_S}s around {BLOCKAGE_CENTER})"
    )

    last = start
    while True:
        now = time.monotonic()
        elapsed = now - start
        dt = now - last
        last = now
        blockage_active = elapsed >= BLOCKAGE_START_S

        stuck_count = 0
        active_count = 0
        for avatar in avatars:
            avatar.tick(elapsed, blockage_active, dt)
            if avatar.stuck:
                stuck_count += 1
            if not avatar.is_active(elapsed):
                continue
            active_count += 1
            producer.produce(
                TOPIC, key=avatar.avatar_id, value=json.dumps(avatar.to_event())
            )
        producer.flush()

        print(
            f"t={elapsed:5.1f}s  blockage={'ON ' if blockage_active else 'off'}  "
            f"active={active_count}  stuck={stuck_count}/{AVATAR_COUNT}"
        )
        time.sleep(1)


if __name__ == "__main__":
    main()

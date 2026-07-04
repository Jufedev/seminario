"""WebSocket <-> Kafka bridge — the "metaverse backend" of the architecture.

Browser (Three.js) --WS--> bridge --produce--> avatar-positions (Kafka)
red-points (Kafka) --consume--> bridge --WS broadcast--> all browsers

Inbound: parses metaverse JSON envelopes; per-avatar 'agent.position' events
are translated (backend/mapping.py) and produced to the detector input topic.
Any other topic is ignored gracefully (debug-logged once per topic name).

Outbound: a background consumer of the detector output topic broadcasts each
red point (mapped back to metaverse world space) to every connected client.

Runs unchanged against local Kafka and Azure Event Hubs (Kafka endpoint):
set EVENTHUBS_CONNECTION_STRING to switch to Azure — same pattern as
analytics/red_point_detector.py.

Run: python backend/bridge.py  (or `make bridge`)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import threading

import websockets
from confluent_kafka import Consumer, KafkaException, Producer

try:
    from backend.mapping import map_agent_position, map_red_point
except ImportError:  # executed as a script: python backend/bridge.py
    from mapping import map_agent_position, map_red_point

BRIDGE_HOST = os.getenv("BRIDGE_HOST", "0.0.0.0")
BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", "8765"))
KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")
INPUT_TOPIC = os.getenv("INPUT_TOPIC", "avatar-positions")
OUTPUT_TOPIC = os.getenv("OUTPUT_TOPIC", "red-points")
CONSUMER_GROUP = os.getenv("CONSUMER_GROUP", "metaverse-backend")
# Reported to browsers alongside each red point so they can size the overlay.
# Must match the CELL_SIZE the detector runs with (see integration contract).
CELL_SIZE = float(os.getenv("CELL_SIZE", "38"))
SUMMARY_INTERVAL_S = 10

# When set, connects to Azure Event Hubs instead of local Kafka
EVENTHUBS_CONNECTION_STRING = os.getenv("EVENTHUBS_CONNECTION_STRING", "")

log = logging.getLogger("bridge")


def kafka_config(extra: dict | None = None) -> dict:
    """Same dev <-> prod switch as red_point_detector.kafka_options,
    expressed with confluent-kafka (librdkafka) option names."""
    conf = {"bootstrap.servers": KAFKA_BOOTSTRAP}
    if EVENTHUBS_CONNECTION_STRING:
        conf.update(
            {
                "security.protocol": "SASL_SSL",
                "sasl.mechanism": "PLAIN",
                "sasl.username": "$ConnectionString",
                "sasl.password": EVENTHUBS_CONNECTION_STRING,
            }
        )
    if extra:
        conf.update(extra)
    return conf


class Bridge:
    def __init__(self):
        self.clients: set = set()
        self.producer: Producer | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.stop_consumer = threading.Event()
        self.produced = 0
        self.relayed = 0
        self.dropped = 0
        self._unknown_topics: set = set()

    # ── Inbound: browser -> Kafka ────────────────────────────────────────

    async def handle_client(self, websocket) -> None:
        remote = websocket.remote_address
        self.clients.add(websocket)
        log.info("Client connected: %s (%d connected)", remote, len(self.clients))
        try:
            async for raw in websocket:
                self._handle_inbound(raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            log.info("Client disconnected: %s (%d connected)", remote, len(self.clients))

    def _handle_inbound(self, raw) -> None:
        try:
            event = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.debug("Dropping malformed message (not JSON)")
            return
        if not isinstance(event, dict):
            return

        topic = event.get("topic")
        if topic == "agent.position":
            mapped = map_agent_position(event)
            if mapped is None:
                # Legacy aggregate sample or malformed per-avatar event.
                return
            try:
                self.producer.produce(
                    INPUT_TOPIC,
                    json.dumps(mapped).encode("utf-8"),
                    key=mapped["avatar_id"].encode("utf-8"),
                )
            except BufferError:
                # librdkafka local queue is full (broker down or slow):
                # drop the event instead of killing the client's WS session.
                self.producer.poll(0)
                self.dropped += 1
                if self.dropped == 1 or self.dropped % 1000 == 0:
                    log.warning("Kafka queue full, dropping events (dropped=%d)", self.dropped)
                return
            except KafkaException as exc:
                self.dropped += 1
                log.warning("Kafka produce failed: %s (dropped=%d)", exc, self.dropped)
                return
            self.producer.poll(0)  # serve delivery callbacks, non-blocking
            self.produced += 1
        elif (
            isinstance(topic, str)
            and topic not in self._unknown_topics
            and len(self._unknown_topics) < 100
        ):
            self._unknown_topics.add(topic)
            log.debug("Ignoring metaverse topic '%s' (future work: ADLS archive)", topic)

    # ── Outbound: Kafka -> browsers ──────────────────────────────────────

    def consume_red_points(self) -> None:
        """Blocking consumer loop, runs in a background thread."""
        consumer = Consumer(
            kafka_config({"group.id": CONSUMER_GROUP, "auto.offset.reset": "latest"})
        )
        consumer.subscribe([OUTPUT_TOPIC])
        log.info("Consuming '%s' (group %s)", OUTPUT_TOPIC, CONSUMER_GROUP)
        try:
            while not self.stop_consumer.is_set():
                try:
                    msg = consumer.poll(timeout=1.0)
                    if msg is None:
                        continue
                    if msg.error():
                        log.warning("Consumer error: %s", msg.error())
                        continue
                    try:
                        record = json.loads(msg.value())
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        log.debug("Dropping malformed red-point record")
                        continue
                    mapped = map_red_point(record, cell_size=CELL_SIZE)
                    if mapped is None:
                        log.debug("Dropping red-point record with missing fields")
                        continue
                    self.relayed += 1
                    log.info(
                        "Red point relayed: cell=(%d, %d) center=(%.1f, %.1f) avatars=%d",
                        mapped["cell_x"],
                        mapped["cell_y"],
                        mapped["center_x"],
                        mapped["center_z"],
                        mapped["stationary_avatars"],
                    )
                    try:
                        asyncio.run_coroutine_threadsafe(
                            self.broadcast(json.dumps(mapped)), self.loop
                        )
                    except RuntimeError:
                        break  # event loop already closed (shutdown race)
                except Exception:
                    if self.stop_consumer.is_set():
                        break
                    # A dead relay is a silent outage for pipeline mode: be loud.
                    log.exception("red-points consumer iteration failed; retrying in 1s")
                    self.stop_consumer.wait(1.0)
        finally:
            consumer.close()

    async def broadcast(self, payload: str) -> None:
        if not self.clients:
            return
        # Failed sends mark the connection closed; handle_client cleans it up.
        await asyncio.gather(
            *(ws.send(payload) for ws in list(self.clients)),
            return_exceptions=True,
        )

    # ── Periodic throughput summary ──────────────────────────────────────

    async def summary_task(self) -> None:
        last_produced = 0
        while True:
            await asyncio.sleep(SUMMARY_INTERVAL_S)
            delta = self.produced - last_produced
            last_produced = self.produced
            if delta or self.clients:
                log.info(
                    "clients=%d inbound=%.1f ev/s produced=%d red_points_relayed=%d",
                    len(self.clients),
                    delta / SUMMARY_INTERVAL_S,
                    self.produced,
                    self.relayed,
                )

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.producer = Producer(kafka_config())

        stop = self.loop.create_future()

        def request_stop():
            if not stop.done():
                stop.set_result(None)

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                self.loop.add_signal_handler(sig, request_stop)
            except NotImplementedError:
                pass

        consumer_thread = threading.Thread(
            target=self.consume_red_points, name="red-points-consumer", daemon=True
        )
        consumer_thread.start()
        summary = asyncio.create_task(self.summary_task())

        async with websockets.serve(self.handle_client, BRIDGE_HOST, BRIDGE_PORT):
            log.info(
                "Bridge listening on ws://%s:%d  (Kafka %s: %s -> / <- %s)",
                BRIDGE_HOST,
                BRIDGE_PORT,
                "Event Hubs" if EVENTHUBS_CONNECTION_STRING else KAFKA_BOOTSTRAP,
                INPUT_TOPIC,
                OUTPUT_TOPIC,
            )
            await stop

        log.info("Shutting down...")
        summary.cancel()
        self.stop_consumer.set()
        consumer_thread.join(timeout=5)
        self.producer.flush(5)
        log.info("Bridge stopped (produced=%d, relayed=%d)", self.produced, self.relayed)


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    try:
        asyncio.run(Bridge().run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

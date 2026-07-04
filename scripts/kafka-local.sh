#!/usr/bin/env bash
# Local Kafka without Docker — runs the official Apache Kafka distribution
# natively (KRaft single-node) inside the distrobox. Requires Java 17.
#
# Usage:
#   ./scripts/kafka-local.sh install   # download + format storage (first time)
#   ./scripts/kafka-local.sh start     # start broker on localhost:9092
#   ./scripts/kafka-local.sh stop
#   ./scripts/kafka-local.sh status
#   ./scripts/kafka-local.sh logs
#   ./scripts/kafka-local.sh consume <topic>   # tail a topic from the console

set -euo pipefail

KAFKA_VERSION="3.9.1"
SCALA_VERSION="2.13"
KAFKA_DIST="kafka_${SCALA_VERSION}-${KAFKA_VERSION}"
KAFKA_HOME="${KAFKA_HOME:-$HOME/.local/${KAFKA_DIST}}"
DATA_DIR="$KAFKA_HOME/kraft-data"
CONFIG="$KAFKA_HOME/config/kraft/server-local.properties"
DOWNLOAD_URL="https://archive.apache.org/dist/kafka/${KAFKA_VERSION}/${KAFKA_DIST}.tgz"

install() {
    if [ -d "$KAFKA_HOME" ]; then
        echo "Kafka already installed at $KAFKA_HOME"
    else
        echo "Downloading ${KAFKA_DIST}..."
        mkdir -p "$HOME/.local"
        curl -fL "$DOWNLOAD_URL" | tar -xz -C "$HOME/.local"
    fi

    if [ ! -f "$CONFIG" ]; then
        cp "$KAFKA_HOME/config/kraft/server.properties" "$CONFIG"
        # Keep data inside the Kafka dir instead of /tmp (survives reboots)
        sed -i "s|^log.dirs=.*|log.dirs=${DATA_DIR}|" "$CONFIG"
        echo "auto.create.topics.enable=true" >> "$CONFIG"
    fi

    if [ ! -f "$DATA_DIR/meta.properties" ]; then
        echo "Formatting KRaft storage..."
        "$KAFKA_HOME/bin/kafka-storage.sh" format \
            -t "$("$KAFKA_HOME/bin/kafka-storage.sh" random-uuid)" \
            -c "$CONFIG"
    fi
    echo "Install OK. Run: $0 start"
}

start() {
    [ -f "$CONFIG" ] || { echo "Not installed. Run: $0 install"; exit 1; }
    "$KAFKA_HOME/bin/kafka-server-start.sh" -daemon "$CONFIG"
    echo "Kafka starting on localhost:9092 (check with: $0 status)"
}

stop() {
    "$KAFKA_HOME/bin/kafka-server-stop.sh" || true
}

status() {
    if "$KAFKA_HOME/bin/kafka-broker-api-versions.sh" \
        --bootstrap-server localhost:9092 > /dev/null 2>&1; then
        echo "Kafka is UP on localhost:9092"
        "$KAFKA_HOME/bin/kafka-topics.sh" --bootstrap-server localhost:9092 --list
    else
        echo "Kafka is DOWN"
        exit 1
    fi
}

logs() {
    tail -f "$KAFKA_HOME/logs/server.log"
}

consume() {
    local topic="${1:?usage: $0 consume <topic>}"
    "$KAFKA_HOME/bin/kafka-console-consumer.sh" \
        --bootstrap-server localhost:9092 --topic "$topic"
}

case "${1:-}" in
    install) install ;;
    start)   start ;;
    stop)    stop ;;
    status)  status ;;
    logs)    logs ;;
    consume) shift; consume "$@" ;;
    *) echo "usage: $0 {install|start|stop|status|logs|consume <topic>}"; exit 1 ;;
esac

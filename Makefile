# Development workflow for the metaverse real-time analytics pipeline.
# Everything runs inside the distrobox (no Docker required): Kafka runs
# natively via scripts/kafka-local.sh, Python components in the local venv.

VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
KAFKA := ./scripts/kafka-local.sh
TOPIC ?= red-points

.DEFAULT_GOAL := help

.PHONY: help setup test kafka-install kafka-start kafka-stop kafka-status \
        kafka-logs consume detector consumer producer pipeline-check clean \
        docker-up docker-down

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# --- Environment ------------------------------------------------------------

setup: ## Create venv and install Python dependencies (first time)
	test -d $(VENV) || python3 -m venv $(VENV)
	$(PIP) install -r requirements.txt

# --- Kafka (native, no Docker) ----------------------------------------------

kafka-install: ## Download Kafka and format KRaft storage (first time)
	$(KAFKA) install

kafka-start: ## Start the local Kafka broker on localhost:9092
	$(KAFKA) start

kafka-stop: ## Stop the local Kafka broker
	$(KAFKA) stop

kafka-status: ## Check broker status and list topics
	$(KAFKA) status

kafka-logs: ## Tail the broker log
	$(KAFKA) logs

consume: ## Tail a topic from the console (TOPIC=red-points by default)
	$(KAFKA) consume $(TOPIC)

# --- Pipeline components (one terminal each) ---------------------------------

test: ## Run the detection logic test (no Kafka needed)
	$(PYTHON) tests/test_detection_logic.py

detector: ## Run the Spark red-point detector
	$(PYTHON) analytics/red_point_detector.py

consumer: ## Run the red-points consumer (simulated backend)
	$(PYTHON) simulator/consumer.py

producer: ## Run the avatar simulator
	$(PYTHON) simulator/producer.py

pipeline-check: kafka-status test ## Verify broker is up and logic test passes

# --- Docker alternative (host with Docker only) -------------------------------

docker-up: ## Start Kafka + Kafka UI + Floci via Docker Compose
	docker compose up -d

docker-down: ## Stop the Docker Compose stack
	docker compose down

# --- Housekeeping -------------------------------------------------------------

clean: ## Remove Spark checkpoints (required when detection params change)
	rm -rf checkpoints/

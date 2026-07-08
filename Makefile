# Single entry point for the whole project. Everything runs inside the
# "seminario" distrobox (the host stays bare): native Kafka, PySpark in a
# local venv, and the Three.js metaverse via bun.
#
# One codebase, two environments — selected by which profile you copy to .env:
#   cp env/env.dev.example  .env     # local distrobox (native Kafka, local Spark)
#   cp env/env.prod.example .env     # Azure (Event Hubs + Databricks)
# The detector and the metaverse read the same KAFKA_BOOTSTRAP / EVENTHUBS_*
# variables, so switching environments never changes code.

# Load the active environment profile (if present) and export it to every recipe.
-include .env
export

VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
KAFKA := ./scripts/kafka-local.sh
TOPIC ?= red-points
# Detector grid defaults — must match the metaverse zone overlay: 60x60 cells
# anchored mid-block at (-240,-195) (see env/env.dev.example).
CELL_SIZE_X ?= 60
CELL_SIZE_Y ?= 60
GRID_ORIGIN_X ?= -240
GRID_ORIGIN_Y ?= -195

.DEFAULT_GOAL := help

.PHONY: help box setup test \
        kafka-install kafka-start kafka-stop kafka-status kafka-logs consume \
        detector \
        metaverse-install metaverse-test metaverse-server metaverse-web \
        infra-init infra-plan infra-apply \
        docker-kafka-up docker-kafka-down clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# --- Environment (dev) ------------------------------------------------------

box: ## (run on the HOST) Create the distrobox from distrobox.ini
	distrobox assemble create --file distrobox.ini
	@echo "Now: distrobox enter seminario"

setup: ## Create the Python venv and install detector deps (pyspark)
	test -d $(VENV) || python3 -m venv $(VENV)
	$(PIP) install -r requirements.txt

# --- Kafka (dev, native — no Docker) ----------------------------------------

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

# --- Big Data pipeline (the detector of record) -----------------------------

test: ## Run the Python detector tests (detection logic + JS→Spark parsing seam; no Kafka needed)
	$(PYTHON) tests/test_detection_logic.py
	$(PYTHON) tests/test_position_parsing.py

detector: ## Run the Spark red-point detector (reads .env for broker + grid)
	CELL_SIZE_X=$(CELL_SIZE_X) CELL_SIZE_Y=$(CELL_SIZE_Y) \
	GRID_ORIGIN_X=$(GRID_ORIGIN_X) GRID_ORIGIN_Y=$(GRID_ORIGIN_Y) \
	$(PYTHON) pipeline/red_point_detector.py

# --- Metaverse (data source + renderer, via bun) ----------------------------

metaverse-install: ## Install metaverse dependencies (first time)
	cd metaverse && bun install

metaverse-test: ## Run the metaverse JS tests (bun test — no Kafka needed)
	cd metaverse && bun test

metaverse-server: ## Run the authoritative server (produces avatar-positions, consumes red-points)
	cd metaverse && bun server/index.js

metaverse-web: ## Run the browser client (Vite dev server via bun)
	cd metaverse && bun run dev

dev: ## Bring up the WHOLE local loop with one command (Kafka+detector+server+web; Ctrl-C stops all)
	./scripts/dev-up.sh

# --- Infrastructure (prod — Azure via Terraform) ----------------------------

infra-init: ## terraform init (needs ARM_SUBSCRIPTION_ID)
	cd infra && terraform init

infra-plan: ## terraform plan
	cd infra && terraform plan

infra-apply: ## terraform apply (provisions Event Hubs + Databricks + ADLS)
	cd infra && terraform apply

# --- Docker alternative for Kafka (if you prefer it over native) ------------

docker-kafka-up: ## Start Kafka via Docker Compose (alternative to native)
	docker compose -f metaverse/docker-compose.yml up -d

docker-kafka-down: ## Stop the Docker Kafka
	docker compose -f metaverse/docker-compose.yml down

# --- Housekeeping -----------------------------------------------------------

clean: ## Remove Spark checkpoints (required when detection params change)
	rm -rf checkpoints/

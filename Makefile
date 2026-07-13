# Single entry point for the whole project. Everything runs inside the
# "seminario" distrobox (the host stays bare): native Kafka, PySpark in a
# local venv, and the Three.js metaverse via bun.
#
# One codebase, two environments — selected by which profile you copy to .env:
#   cp env/env.dev.example  .env     # local distrobox (native Kafka, local Spark)
#   cp env/env.prod.example .env     # Azure (Event Hubs + the detector container)
# The detector and the metaverse read the same KAFKA_BOOTSTRAP / EVENTHUBS_*
# variables, so switching environments never changes code. In Azure the detector
# runs the SAME pipeline/red_point_detector.py, inside a container.

# Load the active environment profile (if present) and export it to every recipe.
-include .env
export

VENV := .venv
PYTHON := $(VENV)/bin/python
PIP := $(VENV)/bin/pip
KAFKA := ./scripts/kafka-local.sh
TOPIC ?= red-points
# Detector grid defaults — must match the metaverse zone overlay: 30x30 cells
# anchored mid-block at (-240,-195) (see env/env.dev.example).
CELL_SIZE_X ?= 30
CELL_SIZE_Y ?= 30
GRID_ORIGIN_X ?= -240
GRID_ORIGIN_Y ?= -195

.DEFAULT_GOAL := help

.PHONY: help box setup test \
        kafka-install kafka-start kafka-stop kafka-status kafka-logs consume \
        detector \
        metaverse-install metaverse-test metaverse-server metaverse-web \
        deploy detector-start detector-stop deploy-status deploy-down \
        infra-init infra-plan infra-apply \
        docker-kafka-up docker-kafka-down clean

help: ## Show available targets
	@# -h: `-include .env` puts a second file in MAKEFILE_LIST, and grep would
	@# then prefix every match with its filename instead of the target name.
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
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
# deploy is the whole thing (infra + app on the VM + the detector container); the
# infra-* targets are the escape hatch for driving Terraform by hand.
#
# ONE Terraform stage. The apply also BUILDS the detector image, with `az acr build`
# (inside Azure — there is no Docker on this box), because the Container App cannot
# reference an image that does not exist yet. See infra/detector.tf.

deploy: ## Deploy EVERYTHING to Azure (infra + app VM + the detector container)
	./scripts/deploy-azure.sh up

detector-start: ## Turn the Azure detector ON (scales the container to 1 replica — bills per hour)
	./scripts/deploy-azure.sh start

detector-stop: ## Turn the Azure detector OFF (0 replicas). NOT $0 for the deployment — the VM and Event Hubs keep billing; only deploy-down is $0
	./scripts/deploy-azure.sh stop

deploy-status: ## Show the Azure deployment status (web, VM, detector)
	./scripts/deploy-azure.sh status

deploy-down: ## Destroy the whole Azure deployment
	./scripts/deploy-azure.sh down

infra-init: ## terraform init (needs ARM_SUBSCRIPTION_ID)
	cd infra && terraform init

infra-plan: ## terraform plan
	cd infra && terraform plan

# The guard runs FIRST and can abort the apply. If the budget kill-switch has fired, it
# scaled the detector to 0 replicas OUTSIDE Terraform — and a plain `terraform apply`
# would happily converge that back to the declared `detector_running = true`, silently
# switching the billing back on. The escape hatch must not be a way around the safety net.
infra-apply: ## terraform apply (Event Hubs + ADLS + the VM + the detector container)
	./scripts/deploy-azure.sh guard
	cd infra && terraform apply

# --- Docker alternative for Kafka (if you prefer it over native) ------------

docker-kafka-up: ## Start Kafka via Docker Compose (alternative to native)
	docker compose -f metaverse/docker-compose.yml up -d

docker-kafka-down: ## Stop the Docker Kafka
	docker compose -f metaverse/docker-compose.yml down

# --- Housekeeping -----------------------------------------------------------

clean: ## Remove Spark checkpoints (required when detection params change)
	rm -rf checkpoints/

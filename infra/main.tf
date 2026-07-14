# Real-time analytics infrastructure for the metaverse traffic project — THE WORKLOAD.
#
# Pipeline:  metaverse backend -> Event Hubs (Kafka endpoint) -> the detector
#            container (Spark Structured Streaming, see detector.tf)
#            -> Event Hubs -> metaverse backend
# Storage:   ADLS Gen2 for the raw historical event archive.
# Compute:   one VM hosting the metaverse frontend and backend, plus the
#            serverless container that runs the detector.
#
# EVERYTHING IN THIS MODULE BILLS, AND EVERYTHING IN IT IS EPHEMERAL. `make deploy-down`
# destroys this state and nothing else. The budget, the action group and the kill-switch
# live in governance/ — a SEPARATE root module with a SEPARATE state, applied once and
# never torn down, because a cost guard that dies with the thing it guards is not a guard.
# governance/main.tf explains the split; infra/README.md explains what the operator sees.
#
# The six resource groups belong to governance too. They are free, they are the skeleton,
# and they are what the kill-switch's RG-scoped role assignments are pinned to — so they
# have to still be standing after a teardown. This module only LOOKS THEM UP (below).
#
# Layout follows docs/arquitectura.drawio: one resource group per pipeline role under
# SUB-Prod. The management group and subscription are managed outside Terraform.

locals {
  # Governance tags (Well-Architected: operational excellence). They are for humans and for
  # cost reporting — `az resource list --query "[].{n:name, p:tags.proposito}"`.
  #
  # They are NOT how the kill-switch finds its targets: the runbook lists the app and
  # analytics resource groups directly (governance/killswitch.ps1 explains why a tag query
  # would fail silently on a four-action role). So a missing tag here costs you a readable
  # portal, not a budget cut that never fires.
  tags = {
    project     = var.project_name
    environment = "production"
    managed_by  = "terraform"
    workload    = "real-time-analytics"
  }
}

resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# --- Resource groups: looked up, not created -------------------------------
# They are declared in governance/, whose state a demo teardown never touches. The names are
# deterministic (`rg-<project>-<role>`), so a data source is all the coupling needed — no
# remote state, no outputs to wire, no ordering to get right beyond "governance first".
#
# If governance has not been applied, these lookups fail with "Resource Group not found" and
# the apply stops before creating anything. That is the correct failure: the workload cannot
# exist without the skeleton, and it must not silently invent its own.
#
# Their `location` also feeds every resource below, which is why the workload does not
# declare a region of its own: the skeleton decides where the deployment lives.

data "azurerm_resource_group" "network" {
  name = "rg-${var.project_name}-network"
}

data "azurerm_resource_group" "app" {
  name = "rg-${var.project_name}-app"
}

data "azurerm_resource_group" "streaming" {
  name = "rg-${var.project_name}-streaming"
}

data "azurerm_resource_group" "analytics" {
  name = "rg-${var.project_name}-analytics"
}

data "azurerm_resource_group" "datalake" {
  name = "rg-${var.project_name}-datalake"
}

# --- Network: VNet with a public subnet for the app VM --------------------

resource "azurerm_virtual_network" "app" {
  name                = "vnet-${var.project_name}-app"
  location            = data.azurerm_resource_group.network.location
  resource_group_name = data.azurerm_resource_group.network.name
  address_space       = ["10.0.0.0/16"]
  tags                = merge(local.tags, { proposito = "Red privada de la VM del metaverso" })
}

resource "azurerm_subnet" "app_public" {
  name                 = "snet-${var.project_name}-app-public"
  resource_group_name  = data.azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-${var.project_name}-app"
  location            = data.azurerm_resource_group.network.location
  resource_group_name = data.azurerm_resource_group.network.name
  tags                = merge(local.tags, { proposito = "Firewall de la VM: abre SSH (22), web (80) y WebSocket (8080)" })

  security_rule {
    name                       = "allow-ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "allow-http"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "allow-websocket"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.app_port)
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "public" {
  subnet_id                 = azurerm_subnet.app_public.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# --- Compute: VM hosting the metaverse frontend and backend ---------------

resource "azurerm_public_ip" "app" {
  name                = "pip-${var.project_name}-app"
  location            = data.azurerm_resource_group.app.location
  resource_group_name = data.azurerm_resource_group.app.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = merge(local.tags, { proposito = "IP publica fija por la que el equipo entra al metaverso" })
}

resource "azurerm_network_interface" "app" {
  name                = "nic-${var.project_name}-app"
  location            = data.azurerm_resource_group.app.location
  resource_group_name = data.azurerm_resource_group.app.name
  tags                = merge(local.tags, { proposito = "Placa de red de la VM: la conecta a la subnet y a su IP publica" })

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.app_public.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.app.id
  }
}

resource "azurerm_linux_virtual_machine" "app" {
  name                  = "vm-${var.project_name}-app"
  location              = data.azurerm_resource_group.app.location
  resource_group_name   = data.azurerm_resource_group.app.name
  size                  = var.vm_size
  admin_username        = var.vm_admin_username
  network_interface_ids = [azurerm_network_interface.app.id]
  # What makes this VM reachable by the kill-switch is the resource group it lives in, not
  # its tags: the runbook lists rg-<project>-app and deallocates whatever VM it finds there
  # (governance/killswitch.ps1 explains why a tag query would fail silently). Move this VM to
  # another group and the guard stops seeing it — and it would keep billing through a cut.
  tags = merge(local.tags, { proposito = "Sirve el frontend Three.js (nginx :80) y el backend WebSocket (bun :8080)" })

  admin_ssh_key {
    username   = var.vm_admin_username
    public_key = var.vm_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  # cloud-init: installs bun + nginx, builds the Vite client, and runs the
  # authoritative server as a systemd unit wired to Event Hubs.
  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
    repo_url                    = var.repo_url
    admin_username              = var.vm_admin_username
    kafka_bootstrap             = "${azurerm_eventhub_namespace.main.name}.servicebus.windows.net:9093"
    eventhubs_connection_string = azurerm_eventhub_namespace_authorization_rule.app.primary_connection_string
  }))
}

# --- Event Hubs: the "Apache Kafka" of the architecture -------------------
# Standard tier is the minimum that exposes the Kafka protocol endpoint
# (Basic does NOT support Kafka). 1 throughput unit = 1 MB/s in, 2 MB/s out,
# far above what the simulation produces.

resource "azurerm_eventhub_namespace" "main" {
  name                = "evhns-${var.project_name}-${random_string.suffix.result}"
  location            = data.azurerm_resource_group.streaming.location
  resource_group_name = data.azurerm_resource_group.streaming.name
  sku                 = "Standard"
  capacity            = 1
  minimum_tls_version = "1.2"
  tags                = merge(local.tags, { proposito = "El 'Kafka' del pipeline: transporta avatar-positions, red-points y sim-events" })
}

# Retention is 7 days — the Standard tier's maximum, and it costs nothing extra
# (it is covered by the tier's included storage). One day was the default and it
# was a trap: the detector's checkpoint lives on ADLS and outlives any stop, so a
# demo run three days after the last one would resume from offsets Event Hubs had
# already dropped. The detector also sets failOnDataLoss=false, so it now survives
# that on its own — but keeping a week of history means it usually has nothing to
# survive, and it makes replaying a run for the H1 measurement possible at all.
resource "azurerm_eventhub" "avatar_positions" {
  name              = "avatar-positions"
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 4
  message_retention = 7
}

resource "azurerm_eventhub" "red_points" {
  name              = "red-points"
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 1
  message_retention = 7
}

# All internal simulation topics travel consolidated in one hub (the logical
# topic rides inside each message): Event Hubs Standard caps a namespace at
# 10 event hubs, and the metaverse would otherwise need 13.
resource "azurerm_eventhub" "sim_events" {
  name              = "sim-events"
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 1
  message_retention = 7
}

# NO consumer groups are declared, and that is deliberate: none of the readers takes a
# group id we could give it.
#
#   * Spark's Kafka source does not take a group id from us. It generates its own
#     (`spark-kafka-source-<uuid>`) and tracks offsets in ITS checkpoint, not in the
#     broker. That is the whole design: the checkpoint is the source of truth, which
#     is what makes the restart semantics exactly-once.
#   * RedPointStore uses a per-process ephemeral group id on purpose
#     (`ecci-redpoints-<pid>-<ts>`), so that a server restart cannot resurrect stale
#     red zones from a committed offset. Red zones are LIVE state with a TTL.
#   * The analytics consumer sets `ecci-analytics` in the client itself
#     (metaverse/analytics/consumer.js), not here.
#
# Declaring groups nobody uses is worse than declaring none: it suggests somebody is
# tracking offsets in the broker, and nobody's state lives there.

# Single namespace-level connection string for producer, Spark and consumer.
# Enough for an academic project; production would use per-app rules.
resource "azurerm_eventhub_namespace_authorization_rule" "app" {
  name                = "app-access"
  namespace_name      = azurerm_eventhub_namespace.main.name
  resource_group_name = data.azurerm_resource_group.streaming.name
  listen              = true
  send                = true
  manage              = false
}

# --- ADLS Gen2: raw historical archive (the "Big Data" storage) -----------

resource "azurerm_storage_account" "datalake" {
  name                            = "st${var.project_name}${random_string.suffix.result}"
  location                        = data.azurerm_resource_group.datalake.location
  resource_group_name             = data.azurerm_resource_group.datalake.name
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  is_hns_enabled                  = true # hierarchical namespace = ADLS Gen2
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false # no anonymous public blob access

  # Stated explicitly rather than left to the provider default, because the detector
  # depends on it to start at all: Spark opens the checkpoint over abfss:// with
  # shared-key auth. If a subscription policy ever turns account keys off, the failure
  # would surface as a detector that cannot open its checkpoint — nowhere near the
  # setting that caused it. Declaring it means Terraform, not a policy, owns the answer.
  shared_access_key_enabled = true
  # The name cannot be more descriptive than this: Azure caps storage account names at
  # 24 characters, lowercase alphanumeric only — no hyphens. The tag carries the meaning.
  #
  # Two things live here, and only one of them is optional:
  #   checkpoints/  the Spark checkpoint. ALWAYS. This is why is_hns_enabled matters:
  #                 a real hierarchical namespace gives atomic rename, which is the
  #                 primitive Spark's checkpoint commit protocol is built on.
  #   positions/    the raw historical archive. Opt-in (ENABLE_ARCHIVE=true).
  tags = merge(local.tags, { proposito = "Estado del detector: checkpoint de Spark (siempre) y archivo historico de posiciones (opt-in: ENABLE_ARCHIVE=true)" })
}

resource "azurerm_storage_data_lake_gen2_filesystem" "events" {
  name               = "avatar-events"
  storage_account_id = azurerm_storage_account.datalake.id
}

# --- The detector -----------------------------------------------------------
# It runs as a container on Azure Container Apps: see detector.tf, which also
# explains why a container and not a cluster.

# Real-time analytics infrastructure for the metaverse traffic project.
#
# Pipeline:  metaverse backend -> Event Hubs (Kafka endpoint) -> Databricks
#            (Spark Structured Streaming) -> Event Hubs -> metaverse backend
# Storage:   ADLS Gen2 for the raw historical event archive.
# Compute:   one VM hosting the metaverse frontend and backend.
#
# Layout follows docs/arquitectura.drawio: four resource groups
# (network, compute, bigdata, storage) under SUB-Prod. The management
# group and subscription are managed outside Terraform.

locals {
  # Governance tags (Well-Architected: operational excellence)
  tags = {
    project     = var.project_name
    environment = "production"
    managed_by  = "terraform"
    workload    = "real-time-analytics"
  }

  # Azure budgets take percentages, but the thing worth reasoning about is dollars.
  # Keeping the early alert expressed in USD means it stays at $10 even if the ceiling
  # moves.
  budget_alert_threshold_pct = var.budget_alert_amount / var.budget_amount * 100
}

data "azurerm_subscription" "current" {}

resource "random_string" "suffix" {
  length  = 6
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# --- Resource groups -------------------------------------------------------
# One resource group per ROLE in the pipeline, not per Azure resource category:
# someone opening the portal should be able to tell what a group holds without
# opening it. Every group also carries a `proposito` tag, which the portal can
# show as a column.
#
# A sixth group appears in the portal that is NOT declared here:
# rg-<project>-databricks-managed. Databricks creates it (see the workspace
# below) and Terraform never owns it.

resource "azurerm_resource_group" "network" {
  name     = "rg-${var.project_name}-network"
  location = var.location
  tags     = merge(local.tags, { proposito = "Red de la VM: VNet, subnet publica y las reglas de firewall (NSG)" })
}

resource "azurerm_resource_group" "app" {
  name     = "rg-${var.project_name}-app"
  location = var.location
  tags     = merge(local.tags, { proposito = "La VM que sirve el metaverso: frontend Three.js + backend WebSocket" })
}

resource "azurerm_resource_group" "streaming" {
  name     = "rg-${var.project_name}-streaming"
  location = var.location
  tags     = merge(local.tags, { proposito = "Transporte de eventos: Event Hubs, el 'Kafka' administrado del pipeline" })
}

resource "azurerm_resource_group" "analytics" {
  name     = "rg-${var.project_name}-analytics"
  location = var.location
  tags     = merge(local.tags, { proposito = "Procesamiento: Databricks, donde corre el detector de zonas rojas en Spark" })
}

resource "azurerm_resource_group" "datalake" {
  name     = "rg-${var.project_name}-datalake"
  location = var.location
  tags     = merge(local.tags, { proposito = "Archivo historico de eventos en ADLS Gen2 (la pata Big Data)" })
}

resource "azurerm_resource_group" "governance" {
  name     = "rg-${var.project_name}-governance"
  location = var.location
  tags     = merge(local.tags, { proposito = "Control de gasto: el kill-switch del presupuesto (no sirve trafico)" })
}

# --- Network: VNet with a public subnet for the app VM --------------------

resource "azurerm_virtual_network" "app" {
  name                = "vnet-${var.project_name}-app"
  location            = azurerm_resource_group.network.location
  resource_group_name = azurerm_resource_group.network.name
  address_space       = ["10.0.0.0/16"]
  tags                = merge(local.tags, { proposito = "Red privada de la VM del metaverso" })
}

resource "azurerm_subnet" "app_public" {
  name                 = "snet-${var.project_name}-app-public"
  resource_group_name  = azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-${var.project_name}-app"
  location            = azurerm_resource_group.network.location
  resource_group_name = azurerm_resource_group.network.name
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
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = merge(local.tags, { proposito = "IP publica fija por la que el equipo entra al metaverso" })
}

resource "azurerm_network_interface" "app" {
  name                = "nic-${var.project_name}-app"
  location            = azurerm_resource_group.app.location
  resource_group_name = azurerm_resource_group.app.name
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
  location              = azurerm_resource_group.app.location
  resource_group_name   = azurerm_resource_group.app.name
  size                  = var.vm_size
  admin_username        = var.vm_admin_username
  network_interface_ids = [azurerm_network_interface.app.id]
  tags                  = merge(local.tags, { proposito = "Sirve el frontend Three.js (nginx :80) y el backend WebSocket (bun :8080)" })

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
  location            = azurerm_resource_group.streaming.location
  resource_group_name = azurerm_resource_group.streaming.name
  sku                 = "Standard"
  capacity            = 1
  minimum_tls_version = "1.2"
  tags                = merge(local.tags, { proposito = "El 'Kafka' del pipeline: transporta avatar-positions, red-points y sim-events" })
}

resource "azurerm_eventhub" "avatar_positions" {
  name              = "avatar-positions"
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 4
  message_retention = 1
}

resource "azurerm_eventhub" "red_points" {
  name              = "red-points"
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 1
  message_retention = 1
}

# All internal simulation topics travel consolidated in one hub (the logical
# topic rides inside each message): Event Hubs Standard caps a namespace at
# 10 event hubs, and the metaverse would otherwise need 13.
resource "azurerm_eventhub" "sim_events" {
  name              = "sim-events"
  namespace_id      = azurerm_eventhub_namespace.main.id
  partition_count   = 1
  message_retention = 1
}

resource "azurerm_eventhub_consumer_group" "spark_detector" {
  name                = "spark-detector"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.avatar_positions.name
  resource_group_name = azurerm_resource_group.streaming.name
}

resource "azurerm_eventhub_consumer_group" "metaverse_backend" {
  name                = "metaverse-backend"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.red_points.name
  resource_group_name = azurerm_resource_group.streaming.name
}

# Single namespace-level connection string for producer, Spark and consumer.
# Enough for an academic project; production would use per-app rules.
resource "azurerm_eventhub_namespace_authorization_rule" "app" {
  name                = "app-access"
  namespace_name      = azurerm_eventhub_namespace.main.name
  resource_group_name = azurerm_resource_group.streaming.name
  listen              = true
  send                = true
  manage              = false
}

# --- ADLS Gen2: raw historical archive (the "Big Data" storage) -----------

resource "azurerm_storage_account" "datalake" {
  name                            = "st${var.project_name}${random_string.suffix.result}"
  location                        = azurerm_resource_group.datalake.location
  resource_group_name             = azurerm_resource_group.datalake.name
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  is_hns_enabled                  = true # hierarchical namespace = ADLS Gen2
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false # no anonymous public blob access
  # The name cannot be more descriptive than this: Azure caps storage account names at
  # 24 characters, lowercase alphanumeric only — no hyphens. The tag carries the meaning.
  tags = merge(local.tags, { proposito = "Archivo historico crudo de posiciones de avatares (opt-in: ENABLE_ARCHIVE=true)" })
}

resource "azurerm_storage_data_lake_gen2_filesystem" "events" {
  name               = "avatar-events"
  storage_account_id = azurerm_storage_account.datalake.id
}

# --- Databricks: runs the Spark Structured Streaming job ------------------
# The workspace itself costs nothing while no cluster is running; the cost
# is per cluster-hour. Create single-node clusters for demos and stop them.

resource "azurerm_databricks_workspace" "detector" {
  name                = "dbw-${var.project_name}-detector"
  location            = azurerm_resource_group.analytics.location
  resource_group_name = azurerm_resource_group.analytics.name
  # Azure retired the Standard SKU: creating one now fails with
  # "DatabricksStandardSkuNotSupported". Premium is the floor.
  sku = "premium"

  # Databricks creates a SECOND resource group of its own, which Terraform does not
  # own and `terraform destroy` does not delete. Naming it explicitly means the team
  # can recognise it in the portal and scripts/deploy-azure.sh can clean it up.
  #
  # What Databricks puts in there: the DBFS root storage account, a Unity Catalog
  # access connector, the workers VNet + NSG, and — while the workspace exists — a NAT
  # gateway with a public IP. That NAT gateway is how the cluster reaches the internet:
  # secure cluster connectivity gives the workers no public IP, so their only way out is
  # SNAT through it. It bills ~$0.045/h for as long as the workspace exists, cluster or
  # no cluster, and it is deleted with the workspace. The DBFS storage and the connector
  # are what survive, and they must be removed before the next workspace can be created.
  managed_resource_group_name = "rg-${var.project_name}-databricks-managed"

  tags = merge(local.tags, { proposito = "Corre el detector de zonas rojas (Spark Structured Streaming) como job continuo" })
}

# --- Budget guard: alert early, then cut the bill --------------------------
# Subscription-level so it covers all four resource groups at once.
#
# A budget only NOTIFIES — Azure has no hard spending cap. So the 100% notification
# also hits an action group that fires the kill-switch runbook (killswitch.tf), which
# deallocates the VM and pauses the Databricks jobs.
#
# ⚠️ Cost data lags by hours: treat this as a safety net, not a brake. The brake is
# `make detector-stop` after the demo.

resource "azurerm_consumption_budget_subscription" "guard" {
  name            = "budget-${var.project_name}"
  subscription_id = data.azurerm_subscription.current.id
  amount          = var.budget_amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  # Early warning, expressed in dollars rather than a magic percentage.
  notification {
    enabled        = true
    threshold      = local.budget_alert_threshold_pct
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }

  # Forecast: the only notification that can arrive BEFORE the money is spent, which
  # matters precisely because actual-cost data is delayed.
  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_emails = var.budget_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 75
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }

  # The kill-switch.
  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
    contact_groups = [azurerm_monitor_action_group.budget.id]
  }

  lifecycle {
    precondition {
      condition     = var.budget_alert_amount < var.budget_amount
      error_message = "budget_alert_amount (the warning) must be below budget_amount (the kill-switch), otherwise the warning would fire together with the shutdown."
    }
  }
}

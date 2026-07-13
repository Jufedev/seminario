# Real-time analytics infrastructure for the metaverse traffic project.
#
# Pipeline:  metaverse backend -> Event Hubs (Kafka endpoint) -> the detector
#            container (Spark Structured Streaming, see detector.tf)
#            -> Event Hubs -> metaverse backend
# Storage:   ADLS Gen2 for the raw historical event archive.
# Compute:   one VM hosting the metaverse frontend and backend, plus the
#            serverless container that runs the detector.
#
# ONE root module, ONE `terraform apply`. v1 was split in two stages
# (infra/ + infra/databricks/) for a single reason: the `databricks` provider had
# to be configured with a workspace URL that was created in the same apply, and a
# provider cannot be configured from a resource it is creating. With Databricks
# gone that constraint is gone with it — and so are the NAT gateway it billed by
# the hour and the rg-<project>-databricks-managed group it left behind on every
# destroy. v1 is preserved on the `v1-databricks` branch.
#
# Layout follows docs/arquitectura.drawio: one resource group per pipeline role
# under SUB-Prod. The management group and subscription are managed outside
# Terraform.

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
# Six groups, and six is what the portal shows. v1 had a SEVENTH,
# rg-<project>-databricks-managed, which Databricks created for itself, Terraform
# never owned, and `terraform destroy` never deleted — it had to be purged by
# hand or it blocked the next deploy. It no longer exists.

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

# Same group as in v1, repurposed: it used to hold the Databricks workspace, it
# now holds the container runtime that replaced it (registry, Container Apps
# environment, the detector app and its logs — see detector.tf). Same role in the
# pipeline, so the same group.
resource "azurerm_resource_group" "analytics" {
  name     = "rg-${var.project_name}-analytics"
  location = var.location
  tags     = merge(local.tags, { proposito = "Procesamiento: el contenedor donde corre el detector de zonas rojas en Spark" })
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

  # Stated explicitly rather than left to the provider default, because the detector
  # now depends on it to start at all: Spark opens the checkpoint over abfss:// with
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
# It used to live here as an azurerm_databricks_workspace. It now runs as a
# container on Azure Container Apps: see detector.tf, which also explains why.

# --- Budget guard: alert early, then cut the bill --------------------------
# Subscription-level so it covers every resource group at once.
#
# A budget only NOTIFIES — Azure has no hard spending cap. So the 100% notification
# also hits an action group that fires the kill-switch runbook (killswitch.tf), which
# deallocates the VM and scales the detector container down to zero replicas.
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

  # The kill-switch. The action group is attached only when the kill-switch exists —
  # otherwise this notification degrades to an email, instead of taking the whole budget
  # (and with it the three warnings above) down with it. A cost guard that can block its
  # own deployment is not a guard.
  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
    contact_groups = var.enable_killswitch ? [azurerm_monitor_action_group.budget[0].id] : []
  }

  lifecycle {
    precondition {
      condition     = var.budget_alert_amount < var.budget_amount
      error_message = "budget_alert_amount (the warning) must be below budget_amount (the kill-switch), otherwise the warning would fire together with the shutdown."
    }
  }
}

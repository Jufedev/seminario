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

resource "azurerm_resource_group" "network" {
  name     = "rg-${var.project_name}-network"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "compute" {
  name     = "rg-${var.project_name}-compute"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "bigdata" {
  name     = "rg-${var.project_name}-bigdata"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "storage" {
  name     = "rg-${var.project_name}-storage"
  location = var.location
  tags     = local.tags
}

# --- Network: VNet with a public subnet for the app VM --------------------

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${var.project_name}"
  location            = azurerm_resource_group.network.location
  resource_group_name = azurerm_resource_group.network.name
  address_space       = ["10.0.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "public" {
  name                 = "snet-${var.project_name}-public"
  resource_group_name  = azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-${var.project_name}-app"
  location            = azurerm_resource_group.network.location
  resource_group_name = azurerm_resource_group.network.name
  tags                = local.tags

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
  subnet_id                 = azurerm_subnet.public.id
  network_security_group_id = azurerm_network_security_group.app.id
}

# --- Compute: VM hosting the metaverse frontend and backend ---------------

resource "azurerm_public_ip" "app" {
  name                = "pip-${var.project_name}-app"
  location            = azurerm_resource_group.compute.location
  resource_group_name = azurerm_resource_group.compute.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "app" {
  name                = "nic-${var.project_name}-app"
  location            = azurerm_resource_group.compute.location
  resource_group_name = azurerm_resource_group.compute.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.public.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.app.id
  }
}

resource "azurerm_linux_virtual_machine" "app" {
  name                  = "vm-${var.project_name}-app"
  location              = azurerm_resource_group.compute.location
  resource_group_name   = azurerm_resource_group.compute.name
  size                  = var.vm_size
  admin_username        = var.vm_admin_username
  network_interface_ids = [azurerm_network_interface.app.id]
  tags                  = local.tags

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
  location            = azurerm_resource_group.bigdata.location
  resource_group_name = azurerm_resource_group.bigdata.name
  sku                 = "Standard"
  capacity            = 1
  minimum_tls_version = "1.2"
  tags                = local.tags
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
  resource_group_name = azurerm_resource_group.bigdata.name
}

resource "azurerm_eventhub_consumer_group" "metaverse_backend" {
  name                = "metaverse-backend"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.red_points.name
  resource_group_name = azurerm_resource_group.bigdata.name
}

# Single namespace-level connection string for producer, Spark and consumer.
# Enough for an academic project; production would use per-app rules.
resource "azurerm_eventhub_namespace_authorization_rule" "app" {
  name                = "app-access"
  namespace_name      = azurerm_eventhub_namespace.main.name
  resource_group_name = azurerm_resource_group.bigdata.name
  listen              = true
  send                = true
  manage              = false
}

# --- ADLS Gen2: raw historical archive (the "Big Data" storage) -----------

resource "azurerm_storage_account" "datalake" {
  name                            = "st${var.project_name}${random_string.suffix.result}"
  location                        = azurerm_resource_group.storage.location
  resource_group_name             = azurerm_resource_group.storage.name
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  is_hns_enabled                  = true # hierarchical namespace = ADLS Gen2
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false # no anonymous public blob access
  tags                            = local.tags
}

resource "azurerm_storage_data_lake_gen2_filesystem" "events" {
  name               = "avatar-events"
  storage_account_id = azurerm_storage_account.datalake.id
}

# --- Databricks: runs the Spark Structured Streaming job ------------------
# The workspace itself costs nothing while no cluster is running; the cost
# is per cluster-hour. Create single-node clusters for demos and stop them.

resource "azurerm_databricks_workspace" "main" {
  name                = "dbw-${var.project_name}"
  location            = azurerm_resource_group.bigdata.location
  resource_group_name = azurerm_resource_group.bigdata.name
  sku                 = "standard"
  tags                = local.tags
}

# --- Budget guard: alert before student credits burn out ------------------
# Subscription-level so it covers all four resource groups at once.

resource "azurerm_consumption_budget_subscription" "guard" {
  name            = "budget-${var.project_name}"
  subscription_id = data.azurerm_subscription.current.id
  amount          = var.budget_amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.budget_start_date
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.budget_contact_emails
  }
}

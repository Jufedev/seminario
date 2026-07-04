# Real-time analytics infrastructure for the metaverse traffic project.
#
# Pipeline:  metaverse backend -> Event Hubs (Kafka endpoint) -> Databricks
#            (Spark Structured Streaming) -> Event Hubs -> metaverse backend
# Storage:   ADLS Gen2 for the raw historical event archive.

locals {
  # Governance tags (Well-Architected: operational excellence)
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

resource "azurerm_resource_group" "main" {
  name     = "rg-${var.project_name}"
  location = var.location
  tags     = local.tags
}

# --- Event Hubs: the "Apache Kafka" of the architecture -------------------
# Standard tier is the minimum that exposes the Kafka protocol endpoint
# (Basic does NOT support Kafka). 1 throughput unit = 1 MB/s in, 2 MB/s out,
# far above what the simulation produces.

resource "azurerm_eventhub_namespace" "main" {
  name                 = "evhns-${var.project_name}-${random_string.suffix.result}"
  location             = azurerm_resource_group.main.location
  resource_group_name  = azurerm_resource_group.main.name
  sku                  = "Standard"
  capacity             = 1
  minimum_tls_version  = "1.2"
  tags                 = local.tags
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

resource "azurerm_eventhub_consumer_group" "spark_detector" {
  name                = "spark-detector"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.avatar_positions.name
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_eventhub_consumer_group" "metaverse_backend" {
  name                = "metaverse-backend"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.red_points.name
  resource_group_name = azurerm_resource_group.main.name
}

# Single namespace-level connection string for producer, Spark and consumer.
# Enough for an academic project; production would use per-app rules.
resource "azurerm_eventhub_namespace_authorization_rule" "app" {
  name         = "app-access"
  namespace_id = azurerm_eventhub_namespace.main.id
  listen       = true
  send         = true
  manage       = false
}

# --- ADLS Gen2: raw historical archive (the "Big Data" storage) -----------

resource "azurerm_storage_account" "datalake" {
  name                            = "st${var.project_name}${random_string.suffix.result}"
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
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
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "standard"
  tags                = local.tags
}

# --- Budget guard: alert before student credits burn out ------------------

resource "azurerm_consumption_budget_resource_group" "guard" {
  name              = "budget-${var.project_name}"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.budget_amount
  time_grain        = "Monthly"

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

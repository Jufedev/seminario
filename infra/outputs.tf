output "kafka_bootstrap" {
  description = "Value for KAFKA_BOOTSTRAP when running against Azure"
  value       = "${azurerm_eventhub_namespace.main.name}.servicebus.windows.net:9093"
}

output "eventhubs_connection_string" {
  description = "Value for EVENTHUBS_CONNECTION_STRING (keep secret)"
  value       = azurerm_eventhub_namespace_authorization_rule.app.primary_connection_string
  sensitive   = true
}

output "datalake_account" {
  description = "ADLS Gen2 storage account holding the Spark checkpoint and the historical archive"
  value       = azurerm_storage_account.datalake.name
}

# The ADLS access key is NOT an output. Nothing outside Terraform consumes it: the
# detector receives it as a Container Apps secret, wired inside detector.tf. Exporting
# a live storage key just so it can sit in somebody's shell history is a liability, and
# an unused output is exactly how that happens.

output "vm_public_ip" {
  description = "Public IP of the VM hosting the metaverse app"
  value       = azurerm_public_ip.app.ip_address
}

# --- The detector ----------------------------------------------------------

output "detector_app_name" {
  description = "Name of the Container App running the Spark detector"
  value       = azurerm_container_app.detector.name
}

output "detector_app_id" {
  description = "Azure resource ID of the detector Container App (scripts/deploy-azure.sh reads its live replica state through this)"
  value       = azurerm_container_app.detector.id
}

output "detector_image" {
  description = "Image the detector runs. The tag is the content hash of the Dockerfile + red_point_detector.py, so it changes if and only if the detector does."
  value       = local.detector_image
}

output "detector_running" {
  description = "DESIRED state of the detector: true = 1 replica (billing), false = 0 replicas. scripts/deploy-azure.sh compares this against the LIVE replica count to detect a kill-switch that fired."
  value       = var.detector_running
}

output "detector_resource_group" {
  description = "Resource group holding the detector Container App (used by the status command to fetch its logs)"
  value       = data.azurerm_resource_group.analytics.name
}

output "detector_checkpoint" {
  description = "ADLS path holding the Spark checkpoint. It carries the Event Hubs offsets and the window state: changing WINDOW_DURATION or the aggregation needs a migration, not a delete."
  value       = local.detector_checkpoint
}

output "detector_archive_path" {
  description = "ADLS path the detector archives raw positions to (empty when ENABLE_ARCHIVE is off)"
  value       = local.detector_archive_path
}

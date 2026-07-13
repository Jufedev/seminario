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
  description = "ADLS Gen2 storage account for the historical archive"
  value       = azurerm_storage_account.datalake.name
}

output "vm_public_ip" {
  description = "Public IP of the VM hosting the metaverse app"
  value       = azurerm_public_ip.app.ip_address
}

output "databricks_workspace_url" {
  description = "Databricks workspace URL (create the cluster and job here)"
  value       = "https://${azurerm_databricks_workspace.detector.workspace_url}"
}

# --- Inputs consumed by the second stage (infra/databricks) ----------------
# The detector job lives in its own root module so that the Databricks provider
# is never configured with values that do not exist yet (a provider cannot be
# configured from a resource created in the same apply). scripts/deploy-azure.sh
# pipes these outputs into that module.

output "databricks_workspace_id" {
  description = "Azure resource ID of the Databricks workspace (used to authenticate the databricks provider)"
  value       = azurerm_databricks_workspace.detector.id
}

output "datalake_access_key" {
  description = "Primary access key of the ADLS account (only needed when the detector archives to ADLS)"
  value       = azurerm_storage_account.datalake.primary_access_key
  sensitive   = true
}

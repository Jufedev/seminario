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
  value       = "https://${azurerm_databricks_workspace.main.workspace_url}"
}

# The six resource groups. The workload module (infra/) does NOT create them: it looks them
# up with `data "azurerm_resource_group"`, by the same deterministic names this module
# builds from var.project_name.
#
# They are outputs anyway, because they are this module's contract with the workload: they
# say, explicitly, what the skeleton offers and what the workload is entitled to expect to
# still be standing after a `make deploy-down`.

output "resource_group_network" {
  description = "Resource group for the VM's network (VNet, subnet, NSG)"
  value       = azurerm_resource_group.network.name
}

output "resource_group_app" {
  description = "Resource group for the VM that serves the metaverse. Also a kill-switch role-assignment scope."
  value       = azurerm_resource_group.app.name
}

output "resource_group_streaming" {
  description = "Resource group for Event Hubs"
  value       = azurerm_resource_group.streaming.name
}

output "resource_group_analytics" {
  description = "Resource group for the detector runtime. Also a kill-switch role-assignment scope."
  value       = azurerm_resource_group.analytics.name
}

output "resource_group_datalake" {
  description = "Resource group for the ADLS Gen2 account (Spark checkpoint + historical archive)"
  value       = azurerm_resource_group.datalake.name
}

output "resource_group_governance" {
  description = "Resource group holding the budget, the action group and the kill-switch Automation Account"
  value       = azurerm_resource_group.governance.name
}

output "killswitch_enabled" {
  description = "Whether the kill-switch Automation Account exists. When false the budget still emails at every threshold; only the automatic shutdown is missing."
  value       = var.enable_killswitch
}

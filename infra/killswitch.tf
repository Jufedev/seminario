# Budget kill-switch — the automation the budget alert triggers at 100%.
#
# An Azure budget does NOT stop spending; it only notifies. To actually cut the bill,
# the budget notifies an action group, which fires a webhook into an Automation runbook
# that deallocates the VM and pauses the Databricks jobs (see killswitch.ps1).
#
# ⚠️ Azure cost data lags by hours. The kill-switch is a SAFETY NET, not a hard cap:
# by the time the budget sees $40, real spend may already be higher. The actual brake
# is still `make detector-stop` after each demo.

resource "azurerm_automation_account" "killswitch" {
  name = "aa-${var.project_name}-killswitch"
  # Not the compute region — see var.killswitch_location: a student subscription allows
  # one Automation Account per region and a deleted one keeps the slot for hours, so a
  # single destroy/apply cycle would lock the main region out. What it manages is
  # unaffected: the Azure control plane is global.
  location            = var.killswitch_location
  resource_group_name = azurerm_resource_group.compute.name
  sku_name            = "Basic" # 500 free job-minutes/month; this runs for seconds
  tags                = local.tags

  identity {
    type = "SystemAssigned"
  }
}

# The runbook reads its targets from these variables instead of being templated, so the
# PowerShell file stays a plain, testable script with no interpolation in it.
resource "azurerm_automation_variable_string" "vm_resource_group" {
  name                    = "VmResourceGroup"
  resource_group_name     = azurerm_resource_group.compute.name
  automation_account_name = azurerm_automation_account.killswitch.name
  value                   = azurerm_resource_group.compute.name
}

resource "azurerm_automation_variable_string" "vm_name" {
  name                    = "VmName"
  resource_group_name     = azurerm_resource_group.compute.name
  automation_account_name = azurerm_automation_account.killswitch.name
  value                   = azurerm_linux_virtual_machine.app.name
}

resource "azurerm_automation_variable_string" "databricks_url" {
  name                    = "DatabricksUrl"
  resource_group_name     = azurerm_resource_group.compute.name
  automation_account_name = azurerm_automation_account.killswitch.name
  value                   = "https://${azurerm_databricks_workspace.main.workspace_url}"
}

# Permissions: scoped to the two resource groups it must act on, not the subscription.
# Contributor on the Databricks workspace's RG also makes the identity a workspace admin
# in Azure Databricks, which is what lets the runbook call the Jobs API.
resource "azurerm_role_assignment" "killswitch_compute" {
  scope                = azurerm_resource_group.compute.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_automation_account.killswitch.identity[0].principal_id
}

resource "azurerm_role_assignment" "killswitch_bigdata" {
  scope                = azurerm_resource_group.bigdata.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_automation_account.killswitch.identity[0].principal_id
}

resource "azurerm_automation_runbook" "killswitch" {
  name                    = "Stop-BillableCompute"
  location                = azurerm_automation_account.killswitch.location
  resource_group_name     = azurerm_resource_group.compute.name
  automation_account_name = azurerm_automation_account.killswitch.name
  runbook_type            = "PowerShell"
  log_progress            = true
  log_verbose             = true
  description             = "Deallocates the app VM and pauses the Databricks jobs when the budget is hit"
  content                 = file("${path.module}/killswitch.ps1")
  tags                    = local.tags
}

resource "azurerm_automation_webhook" "killswitch" {
  name                    = "wh-killswitch"
  resource_group_name     = azurerm_resource_group.compute.name
  automation_account_name = azurerm_automation_account.killswitch.name
  expiry_time             = var.killswitch_webhook_expiry
  enabled                 = true
  runbook_name            = azurerm_automation_runbook.killswitch.name
}

resource "azurerm_monitor_action_group" "budget" {
  name                = "ag-${var.project_name}-budget"
  resource_group_name = azurerm_resource_group.compute.name
  short_name          = "budgetkill"
  tags                = local.tags

  dynamic "email_receiver" {
    for_each = var.budget_contact_emails
    content {
      name          = "email-${email_receiver.key}"
      email_address = email_receiver.value
    }
  }

  automation_runbook_receiver {
    name                    = "stop-billable-compute"
    automation_account_id   = azurerm_automation_account.killswitch.id
    runbook_name            = azurerm_automation_runbook.killswitch.name
    webhook_resource_id     = azurerm_automation_webhook.killswitch.id
    service_uri             = azurerm_automation_webhook.killswitch.uri
    is_global_runbook       = false
    use_common_alert_schema = true
  }
}

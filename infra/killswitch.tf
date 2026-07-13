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
  count = var.enable_killswitch ? 1 : 0

  name = "aa-${var.project_name}-killswitch"
  # See var.killswitch_location: a Student subscription restricts Automation Accounts to
  # its own region list, and the only region that list shares with the subscription's
  # allowed-regions policy is eastus2 — the compute region. It cannot live anywhere else.
  location            = var.killswitch_location
  resource_group_name = azurerm_resource_group.governance.name
  sku_name            = "Basic" # 500 free job-minutes/month; this runs for seconds
  tags                = merge(local.tags, { proposito = "Kill-switch: al tocar el tope del presupuesto apaga lo que cobra por hora" })

  identity {
    type = "SystemAssigned"
  }
}

# The runbook reads its targets from these variables instead of being templated, so the
# PowerShell file stays a plain, testable script with no interpolation in it.
#
# Note the two different groups in play: these variables LIVE next to the Automation
# Account (governance), but their VALUE points at the VM's group (app) — that is the
# target the runbook has to deallocate.
resource "azurerm_automation_variable_string" "vm_resource_group" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "VmResourceGroup"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  value                   = azurerm_resource_group.app.name
}

resource "azurerm_automation_variable_string" "vm_name" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "VmName"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  value                   = azurerm_linux_virtual_machine.app.name
}

resource "azurerm_automation_variable_string" "databricks_url" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "DatabricksUrl"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  value                   = "https://${azurerm_databricks_workspace.detector.workspace_url}"
}

# Permissions: scoped to the two resource groups it must act on, not the subscription.
# Contributor on the Databricks workspace's RG also makes the identity a workspace admin
# in Azure Databricks, which is what lets the runbook call the Jobs API.
resource "azurerm_role_assignment" "killswitch_app" {
  count = var.enable_killswitch ? 1 : 0

  scope                = azurerm_resource_group.app.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_automation_account.killswitch[0].identity[0].principal_id
}

resource "azurerm_role_assignment" "killswitch_analytics" {
  count = var.enable_killswitch ? 1 : 0

  scope                = azurerm_resource_group.analytics.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_automation_account.killswitch[0].identity[0].principal_id
}

resource "azurerm_automation_runbook" "killswitch" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "Stop-BillableCompute"
  location                = azurerm_automation_account.killswitch[0].location
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  runbook_type            = "PowerShell"
  log_progress            = true
  log_verbose             = true
  description             = "Deallocates the app VM and pauses the Databricks jobs when the budget is hit"
  content                 = file("${path.module}/killswitch.ps1")
  tags                    = merge(local.tags, { proposito = "El script que desasigna la VM y pausa los jobs de Databricks" })
}

resource "azurerm_automation_webhook" "killswitch" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "wh-killswitch"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  expiry_time             = var.killswitch_webhook_expiry
  enabled                 = true
  runbook_name            = azurerm_automation_runbook.killswitch[0].name
}

resource "azurerm_monitor_action_group" "budget" {
  count = var.enable_killswitch ? 1 : 0

  name                = "ag-${var.project_name}-budget"
  resource_group_name = azurerm_resource_group.governance.name
  short_name          = "budgetkill"
  tags                = merge(local.tags, { proposito = "Avisa por email y dispara el kill-switch cuando el presupuesto llega al tope" })

  dynamic "email_receiver" {
    for_each = var.budget_contact_emails
    content {
      name          = "email-${email_receiver.key}"
      email_address = email_receiver.value
    }
  }

  automation_runbook_receiver {
    name                    = "stop-billable-compute"
    automation_account_id   = azurerm_automation_account.killswitch[0].id
    runbook_name            = azurerm_automation_runbook.killswitch[0].name
    webhook_resource_id     = azurerm_automation_webhook.killswitch[0].id
    service_uri             = azurerm_automation_webhook.killswitch[0].uri
    is_global_runbook       = false
    use_common_alert_schema = true
  }
}

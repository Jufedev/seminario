# Budget kill-switch — the automation the budget alert triggers at 100%.
#
# An Azure budget does NOT stop spending; it only notifies. To actually cut the bill,
# the budget notifies an action group, which fires a webhook into an Automation runbook
# that stops the two things that bill per hour (see killswitch.ps1):
#
#   1. deallocates the app VM;
#   2. scales the detector Container App down to min_replicas = 0 — the same switch
#      `make detector-stop` uses.
#
# Step 2 is not optional: without it the kill-switch would shut down the VM and leave the
# detector container running, which is the other thing that bills by the hour. A cost guard
# that does not stop the cost is not a guard.
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

# What the runbook is told: WHERE to look. Never WHAT it will find.
#
# All three values below are properties of THIS module — the subscription it guards and two
# resource groups it creates itself. It is NOT handed the VM's name or the detector's
# resource id: those are WORKLOAD identifiers, destroyed and recreated on every demo cycle,
# and pinning them here would put the guard's lifetime back inside the lifetime of the thing
# it guards — the exact coupling this split exists to remove. The runbook lists whatever is
# in those groups at run time, which answers correctly in both states of the world: workload
# up (find it, stop it), workload down (find nothing, nothing bills, nothing to do).
#
# WHY the groups and not a subscription-wide tag query. A tagged `Get-AzResource` looks
# tidier and is a TRAP: it is `GET /subscriptions/{id}/resources`, a SUBSCRIPTION-scope read
# needing `Microsoft.Resources/subscriptions/resources/read`. This identity holds four
# actions, assigned at two RESOURCE GROUPS and nowhere else — so that call would come back
# empty for a PERMISSIONS reason indistinguishable from "the workload is not deployed". The
# guard would report success, cut nothing, and let the bill run on the one day it mattered.
# Listing one resource type inside one group needs only that type's `read` action, which is
# exactly what the role below grants.
resource "azurerm_automation_variable_string" "subscription_id" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "SubscriptionId"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  value                   = data.azurerm_subscription.current.subscription_id
}

resource "azurerm_automation_variable_string" "vm_resource_group" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "VmResourceGroup"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  value                   = azurerm_resource_group.app.name
}

resource "azurerm_automation_variable_string" "detector_resource_group" {
  count = var.enable_killswitch ? 1 : 0

  name                    = "DetectorResourceGroup"
  resource_group_name     = azurerm_resource_group.governance.name
  automation_account_name = azurerm_automation_account.killswitch[0].name
  value                   = azurerm_resource_group.analytics.name
}

# Permissions: a custom role with FOUR actions, not Contributor.
#
# Contributor at RG scope was the easy answer and the wrong one. rg-analytics holds the
# container registry, the Container Apps environment and the detector app itself, so
# Contributor there would let a WEBHOOK-REACHABLE identity — the budget action group
# calls it over a URL — delete the registry, rewrite the app's image, or read its
# secrets. killswitch.ps1 says in its own header that it must not be able to mangle the
# app it is trying to save; the RBAC grant has to agree with that sentence.
#
# What the runbook actually does is deallocate one VM and set one integer. That is all
# it gets:
#
#   virtualMachines/read + deallocate/action   Stop-AzVM does a GET then a POST
#   containerApps/read  + write                the ARM PATCH that sets minReplicas
#
# On `containerApps/write`: ARM has no scale-only data action, and PATCH is a write. So
# write is the floor, not a compromise we chose. What the scoping DOES buy is that the
# blast radius stops at the Container App — the registry, the environment and the
# Log Analytics workspace in the same group stay out of reach entirely.
#
# The two `read` actions are also what makes the DISCOVERY work: listing one resource type
# inside one resource group needs exactly that type's `read` at that scope. So the runbook
# can enumerate the app VM and the detector Container App without holding a single
# subscription-level permission.
resource "azurerm_role_definition" "killswitch" {
  count = var.enable_killswitch ? 1 : 0

  name        = "${var.project_name}-killswitch"
  scope       = data.azurerm_subscription.current.id
  description = "Deallocate the app VM and scale the detector Container App to zero. Nothing else."

  permissions {
    actions = [
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/write",
    ]
    not_actions = []
  }

  # Where the role may be USED. Narrower than where it is defined.
  #
  # These are RESOURCE GROUP scopes, and they keep working across a workload teardown for
  # exactly one reason: the groups are declared in this module, so they survive it. A grant
  # scoped to a group that gets deleted every demo would have to be widened to the whole
  # subscription — which is the trade this split refuses to make.
  assignable_scopes = [
    azurerm_resource_group.app.id,
    azurerm_resource_group.analytics.id,
  ]
}

resource "azurerm_role_assignment" "killswitch_app" {
  count = var.enable_killswitch ? 1 : 0

  scope              = azurerm_resource_group.app.id
  role_definition_id = azurerm_role_definition.killswitch[0].role_definition_resource_id
  principal_id       = azurerm_automation_account.killswitch[0].identity[0].principal_id
}

resource "azurerm_role_assignment" "killswitch_analytics" {
  count = var.enable_killswitch ? 1 : 0

  scope              = azurerm_resource_group.analytics.id
  role_definition_id = azurerm_role_definition.killswitch[0].role_definition_resource_id
  principal_id       = azurerm_automation_account.killswitch[0].identity[0].principal_id
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
  description             = "Deallocates the app VM and scales the detector container to zero replicas when the budget is hit"
  content                 = file("${path.module}/killswitch.ps1")
  tags                    = merge(local.tags, { proposito = "El script que desasigna la VM y apaga el contenedor del detector" })
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

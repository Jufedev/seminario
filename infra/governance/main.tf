# Governance: the durable skeleton of the deployment.
#
# THIS STATE IS APPLIED ONCE AND NEVER DESTROYED BY A DEMO TEARDOWN. That is the whole
# point of it being a separate root module:
#
#   * A cost guard that dies together with the thing it guards is not a guard. The budget,
#     the action group and the kill-switch have to OUTLIVE the VM and the detector, so they
#     cannot share a `terraform destroy` with them.
#   * An Azure for Students subscription allows exactly ONE Automation Account per region,
#     a deleted one keeps holding that slot for HOURS — invisibly, `az automation account
#     list` returns nothing while creation still fails with a 400 — and eastus2 is the only
#     region where an Automation Account may legally live (see var.killswitch_location). An
#     Automation Account that is never deleted can never hit that wall.
#   * Role assignments are scoped to resource GROUPS. If the groups went away with the
#     workload, the four-action least-privilege grant would have to be re-made from scratch
#     on every deploy — or widened to the subscription, which is the wrong trade. The groups
#     live here, so the scopes survive.
#
# What lives here: the six resource groups (they are FREE), the budget, and the kill-switch.
# What does NOT live here: anything that bills by the hour. That is infra/ — the workload,
# which `make deploy-down` destroys.

locals {
  # Governance tags (Well-Architected: operational excellence). The same tag map the workload
  # applies, so the portal can group and cost-report the whole project at once.
  #
  # They are NOT how the kill-switch finds its targets — killswitch.ps1 lists two named
  # resource groups, and its header explains why a tag query would fail silently on a
  # four-action role. A missing tag here costs you a readable portal, not a budget cut that
  # never fires.
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

# --- Resource groups -------------------------------------------------------
# One resource group per ROLE in the pipeline, not per Azure resource category:
# someone opening the portal should be able to tell what a group holds without
# opening it. Every group also carries a `proposito` tag, which the portal can
# show as a column.
#
# Six groups, and six is what the portal shows: everything that exists in Azure is
# declared in one of the two modules, so a seventh group means somebody created
# something by hand.
#
# They are declared HERE, in the state that is never destroyed, and the workload looks them
# up with `data "azurerm_resource_group"`. Groups cost nothing, so keeping six empty ones
# between demos costs nothing — and it is what lets the kill-switch's RG-scoped role
# assignments survive a teardown.

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

# The analytics group holds the detector's whole runtime: registry, Container Apps
# environment, the detector app and its logs — see ../detector.tf.
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

# --- Budget guard: alert early, then cut the bill --------------------------
# Subscription-level so it covers every resource group at once.
#
# A budget only NOTIFIES — Azure has no hard spending cap. So the 100% notification
# also hits an action group that fires the kill-switch runbook (killswitch.tf), which
# deallocates the VM and scales the detector container down to zero replicas.
#
# ⚠️ Cost data lags by hours: treat this as a safety net, not a brake. The brake is
# `make detector-stop` after the demo, and `make deploy-down` after the last one.

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

variable "project_name" {
  description = "Short name used as prefix for all resources (lowercase, no spaces)"
  type        = string
  default     = "metaverso"
}

# An Azure for Students subscription carries an "Allowed resource deployment regions"
# policy. Anything outside that list fails with RequestDisallowedByAzure — a 403, not a
# quota error. Read the actual list before changing this:
#   az policy assignment list --query "[].parameters" -o json
variable "location" {
  description = "Azure region. Must be one allowed by the subscription's region policy (for this one: southcentralus, brazilsouth, eastus2, mexicocentral, canadacentral)."
  type        = string
  default     = "eastus2"
}

variable "budget_amount" {
  description = "Monthly ceiling in USD. Reaching 100% of it fires the kill-switch: the VM is deallocated and the Databricks jobs are paused (nothing is deleted)."
  type        = number
  default     = 40

  validation {
    condition     = var.budget_amount > 0
    error_message = "budget_amount must be greater than 0."
  }
}

variable "budget_alert_amount" {
  description = "Spend in USD at which the first warning email is sent (no action taken)."
  type        = number
  default     = 10

  validation {
    condition     = var.budget_alert_amount > 0
    error_message = "budget_alert_amount must be greater than 0."
  }
}

variable "budget_contact_emails" {
  description = "Emails notified at every budget threshold"
  type        = list(string)
}

# Two different region lists constrain this resource, and only their intersection is legal:
#
#   1. The subscription policy "Allowed resource deployment regions":
#      southcentralus, brazilsouth, eastus2, mexicocentral, canadacentral.
#   2. Azure Automation on a Student/Free subscription, which rejects every region outside
#      eastus, eastus2, westus, northeurope, southeastasia, japanwest with a 400.
#
# The intersection is eastus2 — the compute region itself. There is no other valid choice,
# so this cannot be used to keep the main region's Automation slot free.
#
# The slot matters because a student subscription allows one Automation Account per region
# and a deleted one keeps holding it for hours ("If Deleted recently, please restore the
# same account"). A destroy immediately followed by an apply can therefore fail here; wait,
# or apply with -target to skip the kill-switch until the slot is released.
variable "killswitch_location" {
  description = "Region for the kill-switch Automation Account. Must satisfy BOTH the subscription's allowed-regions policy and the Student-subscription Automation region list — which leaves eastus2 as the only valid value."
  type        = string
  default     = "eastus2"
}

# The one-account-per-region cap has a nasty property: a DELETED account keeps holding the
# slot for hours, and it is invisible (`az automation account list` returns nothing while
# Azure still rejects the create with 400 "Only one account is allowed... If Deleted
# recently, please restore the same account"). So a destroy followed by an apply the same
# day cannot create the kill-switch, no matter what.
#
# That must not be able to block the whole deployment — and it must never take the budget's
# EMAIL alerts down with it. With this off, the budget still notifies at every threshold;
# what is lost is only the automatic shutdown. Turn it back on and re-apply once Azure
# releases the slot.
variable "enable_killswitch" {
  description = "Create the budget kill-switch (Automation Account + runbook + action group). Set to false when Azure still holds the region's Automation slot from a recent delete: the budget keeps emailing, only the automatic shutdown is skipped."
  type        = bool
  default     = true
}

variable "killswitch_webhook_expiry" {
  description = "Expiry of the webhook the budget action group calls (RFC3339). After this date the kill-switch stops firing — re-apply to renew."
  type        = string
  default     = "2027-07-01T00:00:00Z"
}

# Azure for Students caps vCPUs at 6 per region AND at 4 per VM family. So the app VM and
# the Databricks node must sit in DIFFERENT families, or they eat each other's per-family
# quota and the cluster never starts:
#
#   app VM           Standard_E2s_v3   ESv3 family   2 vCPU
#   Databricks node  Standard_D4s_v3   DSv3 family   4 vCPU   (infra/databricks)
#                                      total         6 / 6    <- exactly at the ceiling
#
# Both are Zone-restricted for this subscription but NOT Location-restricted, which means
# they deploy fine regionally — neither the VM nor Databricks pins an availability zone.
# When checking a SKU, that distinction is the whole game:
#
#   az vm list-skus -l <region> --resource-type virtualMachines --all \
#     --query "[?name=='<sku>'].{t:restrictions[0].type, r:restrictions[0].reasonCode}"
#
#   type = Zone      -> usable (only zone-pinned deployments are blocked)
#   type = Location  -> genuinely unavailable to this subscription
#
# Filtering for SKUs with NO restrictions at all is the trap: it hides perfectly usable
# ones. Family quotas: az vm list-usage -l <region> -o table
variable "vm_size" {
  description = "Size of the VM hosting the metaverse frontend and backend. Must be in a different VM family than the Databricks node (see comment above)."
  type        = string
  default     = "Standard_E2s_v3"
}

variable "vm_admin_username" {
  description = "Admin username for the app VM"
  type        = string
  default     = "azureuser"
}

variable "vm_ssh_public_key" {
  description = "SSH public key for the app VM admin user"
  type        = string
}

variable "repo_url" {
  description = "Git URL cloned by cloud-init to deploy the metaverse app (must be reachable without credentials)"
  type        = string
  default     = "https://github.com/Jufedev/seminario.git"
}

variable "app_port" {
  description = "WebSocket port exposed by the metaverse backend"
  type        = number
  default     = 8080
}

variable "budget_start_date" {
  description = "Budget period start (first day of current month, RFC3339)"
  type        = string
  default     = "2026-07-01T00:00:00Z"
}

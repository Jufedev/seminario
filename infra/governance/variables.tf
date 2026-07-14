variable "project_name" {
  description = "Short name used as prefix for all resources (lowercase, no spaces). The resource groups are named rg-<project>-<role>, so this is how the workload module finds them and how the kill-switch runbook knows which two groups to sweep. The workload module MUST agree on it."
  type        = string
  default     = "metaverso"
}

# An Azure for Students subscription carries an "Allowed resource deployment regions"
# policy. Anything outside that list fails with RequestDisallowedByAzure — a 403, not a
# quota error. Read the actual list before changing this:
#   az policy assignment list --query "[].parameters" -o json
variable "location" {
  description = "Azure region for the resource groups. Must be one allowed by the subscription's region policy (for this one: southcentralus, brazilsouth, eastus2, mexicocentral, canadacentral). The workload reads it back from the groups; it is not declared twice."
  type        = string
  default     = "eastus2"
}

variable "budget_amount" {
  description = "Monthly ceiling in USD. Reaching 100% of it fires the kill-switch: the VM is deallocated and the detector container is scaled to zero replicas (nothing is deleted)."
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

variable "budget_start_date" {
  description = "Budget period start (first day of current month, RFC3339)"
  type        = string
  default     = "2026-07-01T00:00:00Z"
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
# same account"). That is precisely why this module is a SEPARATE state that a demo
# teardown never touches: the account is created once and simply never deleted.
variable "killswitch_location" {
  description = "Region for the kill-switch Automation Account. Must satisfy BOTH the subscription's allowed-regions policy and the Student-subscription Automation region list — which leaves eastus2 as the only valid value."
  type        = string
  default     = "eastus2"
}

# The one-account-per-region cap has a nasty property: a DELETED account keeps holding the
# slot for hours, and it is invisible (`az automation account list` returns nothing while
# Azure still rejects the create with 400 "Only one account is allowed... If Deleted
# recently, please restore the same account").
#
# This state is never destroyed by a demo teardown, so the only way to meet that 400 is to
# apply governance while the subscription still holds the slot from an Automation Account
# that existed outside this state. This flag is the escape hatch for that FIRST apply: with
# it off, the budget still emails at every threshold — the resource groups, the budget and
# its warnings all come up — and only the automatic shutdown is skipped. Flip it back on and
# re-apply governance once Azure releases the slot; nothing else in the deployment moves.
variable "enable_killswitch" {
  description = "Create the budget kill-switch (Automation Account + runbook + action group). Set to false only when Azure still holds the region's Automation slot: the budget keeps emailing, only the automatic shutdown is skipped."
  type        = bool
  default     = true
}

variable "killswitch_webhook_expiry" {
  description = "Expiry of the webhook the budget action group calls (RFC3339). After this date the kill-switch stops firing — re-apply to renew."
  type        = string
  default     = "2027-07-01T00:00:00Z"
}

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

# This is now the ONLY VM in the deployment, and that is the quiet headline of v2.
#
# Azure for Students caps vCPUs at 6 per region AND at 4 per VM family. In v1 the app VM
# and the Databricks node had to be squeezed into different families (E2s_v3 + D4s_v3 =
# exactly 6/6, at the ceiling) so they would not starve each other. Then Azure ran out of
# D4s_v3 — the only 4-vCPU SKU this subscription can use in eastus2, since every other one
# is Location-restricted — and the whole deployment failed with
# CLOUD_PROVIDER_RESOURCE_STOCKOUT with nowhere to fall back to.
#
# The detector container has no VM SKU at all (Container Apps Consumption is serverless),
# so nothing competes with this VM any more: 2 of 6 vCPUs, and no per-family contention.
#
# Kept for whoever has to size a VM here again — the Zone/Location distinction is the whole
# game when reading SKU availability:
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
  description = "Size of the VM hosting the metaverse frontend and backend. The only VM in the deployment (see comment above)."
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

# --- Detector lifecycle -----------------------------------------------------

variable "detector_running" {
  description = "Whether the Spark detector container is running. This is the start/stop switch: it sets min_replicas to 1 or 0, and 0 replicas means no container and $0/hour."
  type        = bool
  default     = false
}

# --- Detector calibration ---------------------------------------------------
# Deliberately without defaults: these are the calibrated values of the hypothesis
# and they must match the metaverse zone overlay. Making them REQUIRED means the
# detector cannot be deployed with a silently wrong calibration — a red zone
# painted next to the jam instead of on it is a false result about H1, not a
# cosmetic bug.
#
# The single source of truth is env/env.prod.example. scripts/deploy-azure.sh reads
# it and writes infra/detector.auto.tfvars from it on every deploy, so the detector
# in Azure cannot drift away from the overlay the metaverse renders.

variable "cell_size_x" {
  description = "Grid cell width (must tile the metaverse zone overlay)"
  type        = number
}

variable "cell_size_y" {
  description = "Grid cell height"
  type        = number
}

variable "grid_origin_x" {
  description = "Grid origin X (anchors the cells to the metaverse blocks)"
  type        = number
}

variable "grid_origin_y" {
  description = "Grid origin Y"
  type        = number
}

variable "window_duration" {
  description = "Sliding window duration, Spark interval syntax (e.g. \"10 seconds\")"
  type        = string
}

variable "window_slide" {
  description = "Sliding window slide, Spark interval syntax"
  type        = string
}

variable "min_stationary_avatars" {
  description = "Distinct stopped avatars in a cell required to raise a red point"
  type        = number
}

variable "min_mean_dwell_s" {
  description = "Mean seconds each avatar must stay stopped (excludes traffic-light stops)"
  type        = number
}

# --- Historical archive (the ADLS leg of the Big Data story) ----------------
# OFF by default, and the reason is a landmine in red_point_detector.py: the archive
# stream and the red-point stream are joined by awaitAnyTermination(), so an archive
# that fails on its first batch takes the DETECTOR down with it. Turn it on knowingly.
#
# The checkpoint is NOT governed by this flag — it is always on ADLS (see detector.tf).
variable "enable_archive" {
  description = "Archive the raw avatar-positions feed to ADLS as Parquet. Off by default: the archive stream shares awaitAnyTermination() with the red-point stream, so if it fails it takes the detector with it."
  type        = bool
  default     = false
}

# The Spark checkpoint normally lives on ADLS (see infra/detector.tf): a persistent
# checkpoint is what lets an unplanned Container Apps restart resume from committed
# Event Hubs offsets instead of silently jumping to `latest` and leaving a detection gap.
#
# This overrides that. It exists because the abfss:// shared-key write is the only thing
# in the detector's STARTUP path never executed against a real HNS account — and if it
# fails, the detector does not start at all. Setting this to a container-local path
# (/tmp/checkpoints/red-point-detector) gives back a detector guaranteed to boot, at the
# cost of restart resilience. One flag, decided calmly, instead of editing Terraform with
# a jury waiting.
variable "checkpoint_dir_override" {
  description = "Overrides the Spark checkpoint location. Leave null to use ADLS (the default, and what you want). Set to /tmp/checkpoints/red-point-detector ONLY if the abfss:// checkpoint cannot be opened — the detector then boots but loses its state on every restart."
  type        = string
  default     = null
}

# The budget, the kill-switch and their variables live in governance/ — the other root
# module, the one a demo teardown never destroys. This module holds only what BILLS.

variable "project_name" {
  description = "Short name used as prefix for all resources (lowercase, no spaces). MUST match governance/var.project_name: the resource groups are named rg-<project>-<role>, and that is how this module finds them and how the kill-switch knows which two to sweep."
  type        = string
  default     = "metaverso"
}

# There is no `location` variable here on purpose. The region is a property of the resource
# groups, which governance/ owns, and every resource below reads it back from the group it
# lands in (`data.azurerm_resource_group.<role>.location`). Declaring it twice would let the
# two states disagree about where the deployment lives.

# This is the ONLY VM in the deployment, and that is deliberate.
#
# Azure for Students caps vCPUs at 6 per region AND at 4 per VM family. The detector
# container has no VM SKU at all (Container Apps Consumption is serverless), so nothing
# competes with this VM: 2 of 6 vCPUs, and no per-family contention. That also means no
# SKU that Azure can run out of — which matters here, because in eastus2 nearly every
# 4-vCPU SKU is Location-restricted for this subscription, so a big compute node would
# have exactly one possible size and no fallback if it were unavailable.
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

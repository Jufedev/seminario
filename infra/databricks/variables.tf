# --- Wiring from the first stage (infra/) ---------------------------------

variable "workspace_url" {
  description = "Databricks workspace URL (terraform output databricks_workspace_url)"
  type        = string
}

variable "workspace_id" {
  description = "Azure resource ID of the Databricks workspace (terraform output databricks_workspace_id)"
  type        = string
}

variable "kafka_bootstrap" {
  description = "Event Hubs Kafka endpoint (terraform output kafka_bootstrap)"
  type        = string
}

variable "eventhubs_connection_string" {
  description = "Event Hubs connection string (terraform output -raw eventhubs_connection_string)"
  type        = string
  sensitive   = true
}

# --- Detector lifecycle ----------------------------------------------------

variable "detector_running" {
  description = "Whether the streaming job is running. This is the start/stop switch: false pauses the job, which cancels the run and terminates the job cluster (the only per-hour cost)."
  type        = bool
  default     = false
}

# --- Detection parameters --------------------------------------------------
# Deliberately without defaults: these are the calibrated values of the
# hypothesis and they must match the metaverse zone overlay. Making them
# required means the job cannot be deployed with a silently wrong calibration.
# The single source of truth is env/env.prod.example; scripts/deploy-azure.sh
# reads them from there and writes them into terraform.tfvars.

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

variable "checkpoint_dir" {
  description = "Spark checkpoint location. In prod it holds the Event Hubs offsets: changing the window/aggregation needs a checkpoint migration, not a delete."
  type        = string
  default     = "dbfs:/checkpoints/red-point-detector"
}

# --- Cluster ---------------------------------------------------------------

variable "spark_version" {
  description = "Databricks runtime. The Kafka connector ships with DBR, so the job needs no extra library."
  type        = string
  default     = "15.4.x-scala2.12"
}

# Standard_DS3_v2 (the usual Databricks default) is Location-restricted on Azure for
# Students — genuinely unavailable. D4s_v3 is only Zone-restricted, so it deploys fine
# (Azure Databricks does not pin availability zones: zone_id is an AWS concept).
#
# It deliberately sits in a DIFFERENT VM family than the app VM (Standard_E2s_v3, ESv3):
# the per-family quota is 4 vCPUs, so sharing a family would make the cluster and the VM
# starve each other — and the failure would surface here as a quota error, pointing
# nowhere near the actual cause.
variable "node_type_id" {
  description = "VM size of the single-node job cluster (this is the per-hour cost while the detector runs). 4 vCPUs; must be in a different VM family than var.vm_size in infra/."
  type        = string
  default     = "Standard_D4s_v3"
}

# --- Optional: historical archive to ADLS ----------------------------------

variable "enable_archive" {
  description = "Archive the raw avatar-positions feed to ADLS as Parquet. Off by default: with no storage credential on the cluster the archive stream would fail and take the red-point stream down with it."
  type        = bool
  default     = false
}

variable "datalake_account" {
  description = "ADLS account name (terraform output datalake_account). Required when enable_archive is true."
  type        = string
  default     = ""
}

variable "datalake_access_key" {
  description = "ADLS access key (terraform output -raw datalake_access_key). Required when enable_archive is true."
  type        = string
  default     = ""
  sensitive   = true
}

# --- Secrets ---------------------------------------------------------------

variable "use_secret_scope" {
  description = "Keep the Event Hubs and ADLS credentials in a Databricks secret scope instead of inlining them in the cluster spec. Set to false if the workspace SKU rejects the Secrets API."
  type        = bool
  default     = true
}

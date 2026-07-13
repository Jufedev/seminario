# The Spark detector on Databricks — the last manual piece of the deployment.
#
# Uploads pipeline/red_point_detector.py to the workspace and defines it as a
# CONTINUOUS job on a single-node job cluster. The job cluster only exists while
# the job runs, so `detector_running = false` costs nothing: pausing the job
# cancels the run and terminates the cluster. That flag is the start/stop switch
# used by scripts/deploy-azure.sh.
#
# Continuous (rather than a scheduled run) is what a streaming query wants:
# Databricks keeps it alive and restarts it if the driver dies.

locals {
  scope_name = "seminario"

  # Secret references are resolved by Databricks at cluster start; the raw value
  # never appears in the cluster spec. Falling back to the literal value keeps
  # the module usable on a workspace whose SKU rejects the Secrets API.
  eventhubs_value = (
    var.use_secret_scope
    ? "{{secrets/${local.scope_name}/eventhubs-connection-string}}"
    : var.eventhubs_connection_string
  )
  datalake_key_value = (
    var.use_secret_scope
    ? "{{secrets/${local.scope_name}/datalake-access-key}}"
    : var.datalake_access_key
  )

  archive_path = (
    var.enable_archive
    ? "abfss://avatar-events@${var.datalake_account}.dfs.core.windows.net/positions"
    : ""
  )

  # Without a storage credential the archive stream fails on its first batch and
  # takes the red-point stream down with it (awaitAnyTermination), so the key is
  # wired in only when archiving is on.
  archive_conf = (
    var.enable_archive
    ? { "fs.azure.account.key.${var.datalake_account}.dfs.core.windows.net" = local.datalake_key_value }
    : {}
  )

  # Exactly the env vars pipeline/red_point_detector.py reads.
  detector_env = {
    KAFKA_BOOTSTRAP             = var.kafka_bootstrap
    EVENTHUBS_CONNECTION_STRING = local.eventhubs_value
    INPUT_TOPIC                 = "avatar-positions"
    OUTPUT_TOPIC                = "red-points"
    CHECKPOINT_DIR              = var.checkpoint_dir
    ARCHIVE_PATH                = local.archive_path
    CELL_SIZE_X                 = tostring(var.cell_size_x)
    CELL_SIZE_Y                 = tostring(var.cell_size_y)
    GRID_ORIGIN_X               = tostring(var.grid_origin_x)
    GRID_ORIGIN_Y               = tostring(var.grid_origin_y)
    WINDOW_DURATION             = var.window_duration
    WINDOW_SLIDE                = var.window_slide
    MIN_STATIONARY_AVATARS      = tostring(var.min_stationary_avatars)
    MIN_MEAN_DWELL_S            = tostring(var.min_mean_dwell_s)
  }

  # Databricks exports these through a bash script (`export KEY=VALUE`), so every
  # value is quoted. Unquoted, the Event Hubs connection string would truncate at
  # its first `;` and "10 seconds" would split into two words. The detector reads
  # them back with a quote-tolerant getenv, so both conventions work.
  spark_env_vars = { for k, v in local.detector_env : k => "\"${v}\"" }
}

# --- Job source ------------------------------------------------------------
# The detector runs from the repo file itself: no copy of the logic lives here,
# and a re-apply after editing the detector re-uploads it.

resource "databricks_workspace_file" "detector" {
  source = "${path.module}/../../pipeline/red_point_detector.py"
  path   = "/Shared/seminario/red_point_detector.py"
}

# --- Credentials -----------------------------------------------------------

resource "databricks_secret_scope" "main" {
  count = var.use_secret_scope ? 1 : 0

  name = local.scope_name
  # Databricks-backed scope; ACLs on secrets are a premium feature, so the whole
  # workspace (a single-user academic workspace) manages it.
  initial_manage_principal = "users"
}

resource "databricks_secret" "eventhubs" {
  count = var.use_secret_scope ? 1 : 0

  scope        = databricks_secret_scope.main[0].name
  key          = "eventhubs-connection-string"
  string_value = var.eventhubs_connection_string
}

resource "databricks_secret" "datalake" {
  count = var.use_secret_scope && var.enable_archive ? 1 : 0

  scope        = databricks_secret_scope.main[0].name
  key          = "datalake-access-key"
  string_value = var.datalake_access_key
}

# --- The job ---------------------------------------------------------------

resource "databricks_job" "detector" {
  name        = "red-point-detector"
  description = "Spark Structured Streaming: avatar-positions -> red-points (the detector of record for H1)"

  # Pausing cancels the active run, which terminates the job cluster.
  continuous {
    pause_status = var.detector_running ? "UNPAUSED" : "PAUSED"
  }

  task {
    task_key = "detect"

    new_cluster {
      spark_version = var.spark_version
      node_type_id  = var.node_type_id
      num_workers   = 0 # single node: the simulation is far below one worker's throughput

      spark_conf = merge({
        "spark.databricks.cluster.profile" = "singleNode"
        "spark.master"                     = "local[*, 4]"
        "spark.sql.shuffle.partitions"     = "4"
      }, local.archive_conf)

      custom_tags = {
        ResourceClass = "SingleNode" # required by Databricks for num_workers = 0
        project       = "metaverso"
      }

      spark_env_vars = local.spark_env_vars
    }

    spark_python_task {
      python_file = databricks_workspace_file.detector.path
      source      = "WORKSPACE"
    }
  }

  lifecycle {
    precondition {
      condition     = !var.enable_archive || (var.datalake_account != "" && var.datalake_access_key != "")
      error_message = "enable_archive = true needs datalake_account and datalake_access_key (terraform output datalake_account / -raw datalake_access_key)."
    }
  }
}

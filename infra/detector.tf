# The Spark red-point detector, running as a container on Azure Container Apps.
#
# WHY a container and not a cluster:
#
#   A Spark cluster spreads work across machines, and that only pays for itself when
#   there is something to spread. This pipeline carries one sample per avatar per
#   second — a hundred avatars is a hundred JSON messages a second, which one core
#   handles comfortably. So the detector is a SINGLE JVM in Spark local mode: it never
#   distributes a task. A cluster would add coordination, not capacity.
#
# What running it on Container Apps buys:
#
#   * No VM SKU that can be out of stock. Consumption is serverless — and on an Azure
#     for Students subscription that matters: in eastus2 nearly every 4-vCPU SKU is
#     Location-restricted, so a big compute node would have one possible size and no
#     fallback.
#   * min_replicas is the on/off switch and the container starts in SECONDS.
#   * Nothing bills while it is off: 0 replicas = no process = no meter.
#   * Consumption pricing gives 180k vCPU-s + 360k GiB-s free per month, which at
#     2 vCPU covers ~25 h of detector uptime before it bills anything at all.
#
# The image runs pipeline/red_point_detector.py unmodified: this is still Apache Spark
# Structured Streaming — same windows, same watermark, same checkpoint, same engine.

locals {
  # Container Apps sizing. Consumption requires memory = 2 GiB per vCPU, so
  # 2 vCPU pairs with exactly 4Gi — comfortable headroom for a single-node
  # stateful streaming query.
  detector_cpu    = 2.0
  detector_memory = "4Gi"

  # The image tag is the CONTENT HASH of what goes into the image. Two things fall
  # out of that, and both matter:
  #   1. Editing the detector or the Dockerfile changes the tag, so the Container
  #      App's image reference changes, so Container Apps rolls a new revision.
  #      A mutable `:latest` would have left the old code running.
  #   2. Nothing changed -> same tag -> the image is not rebuilt or re-pushed, and no
  #      new revision is created. Re-applying is free. That property is worth more now
  #      that the push leaves this machine: an unchanged detector sends nothing.
  detector_image_tag = substr(sha256(join("", [
    filesha256("${path.module}/../pipeline/Dockerfile"),
    filesha256("${path.module}/../pipeline/red_point_detector.py"),
    filesha256("${path.module}/../pipeline/entrypoint.sh"),
  ])), 0, 12)

  detector_image = "${azurerm_container_registry.detector.login_server}/red-point-detector:${local.detector_image_tag}"

  # --- Where Spark keeps its state -----------------------------------------
  # Both live on the ADLS account (main.tf), which is why the image bundles the
  # hadoop-azure ABFS driver.
  #
  # THE CHECKPOINT IS PERSISTENT, AND THAT IS THE POINT. An earlier draft kept it on
  # the container filesystem, reasoning that startingOffsets="latest" makes a fresh
  # checkpoint resume from "now". That is fine when a human restarts the detector, and
  # wrong when Container Apps does it: an OOM, an eviction or host maintenance would
  # silently drop the in-flight window state and resume at the latest offset, opening a
  # ~30s detection hole with nothing in the log to show for it. On ADLS, a restarted
  # replica resumes from committed offsets instead.
  #
  # ADLS Gen2 has `is_hns_enabled = true` (a real hierarchical namespace), so it gives
  # ATOMIC RENAME. That is not a nice-to-have for Spark checkpointing — it is the
  # primitive the commit protocol is built on, and flat blob storage cannot provide it.
  #
  # THE CONSEQUENCE: the checkpoint holds
  # the Event Hubs offsets and the aggregation state, so changing WINDOW_DURATION,
  # WINDOW_SLIDE or the aggregation in prod needs a checkpoint MIGRATION, not a delete.
  # `make clean` is a dev-only move. docs/integration-contract.md already says this.
  # var.checkpoint_dir_override is the escape hatch, and it exists because the ABFS
  # shared-key write is the one thing in the detector's STARTUP path that has never
  # been executed against a real HNS account. If it fails, the detector does not start
  # at all — a worse failure than losing the state on a restart. Overriding to
  # a container-local path (e.g. /tmp/checkpoints/red-point-detector) trades restart
  # resilience back for a detector that is guaranteed to boot. That is a trade worth
  # having available with a demo in front of a jury, and worth making in ONE flag
  # rather than by editing Terraform under pressure.
  detector_checkpoint = coalesce(
    var.checkpoint_dir_override,
    "abfss://${azurerm_storage_data_lake_gen2_filesystem.events.name}@${azurerm_storage_account.datalake.name}.dfs.core.windows.net/checkpoints/red-point-detector",
  )

  # The historical archive stays OFF by default. Not timidity: the archive stream and
  # the red-point stream are joined by awaitAnyTermination(), so if the archive fails
  # on its first batch it takes the detector down with it.
  detector_archive_path = (
    var.enable_archive
    ? "abfss://${azurerm_storage_data_lake_gen2_filesystem.events.name}@${azurerm_storage_account.datalake.name}.dfs.core.windows.net/positions"
    : ""
  )

  # Exactly the env vars pipeline/red_point_detector.py reads. The Event Hubs
  # connection string is NOT here: it is a Container Apps secret (see below).
  #
  # Container Apps hands these to the process directly — no `export KEY=VALUE` bash
  # script in between — so no shell quoting trap: the `;` in the connection string
  # cannot truncate it, and "10 seconds" cannot split into two words. Values go in
  # raw. (The detector's quote-tolerant env() helper covers the case where these
  # values ever DO come through a shell; here it is a harmless no-op.)
  detector_env = {
    KAFKA_BOOTSTRAP = "${azurerm_eventhub_namespace.main.name}.servicebus.windows.net:9093"
    INPUT_TOPIC     = azurerm_eventhub.avatar_positions.name
    OUTPUT_TOPIC    = azurerm_eventhub.red_points.name
    CHECKPOINT_DIR  = local.detector_checkpoint
    ARCHIVE_PATH    = local.detector_archive_path

    # Read by entrypoint.sh, not by the detector: Hadoop wants the storage credential
    # as a Spark conf, so the entrypoint turns these into
    # `spark.hadoop.fs.azure.account.key.<account>.dfs.core.windows.net`. The KEY
    # itself is not here — it is a Container Apps secret (below).
    ADLS_ACCOUNT = azurerm_storage_account.datalake.name

    CELL_SIZE_X            = tostring(var.cell_size_x)
    CELL_SIZE_Y            = tostring(var.cell_size_y)
    GRID_ORIGIN_X          = tostring(var.grid_origin_x)
    GRID_ORIGIN_Y          = tostring(var.grid_origin_y)
    WINDOW_DURATION        = var.window_duration
    WINDOW_SLIDE           = var.window_slide
    MIN_STATIONARY_AVATARS = tostring(var.min_stationary_avatars)
    MIN_MEAN_DWELL_S       = tostring(var.min_mean_dwell_s)
  }
}

# --- Registry --------------------------------------------------------------
# Basic is the cheapest SKU (~$5/month, 10 GiB included). The detector image is
# a single ~1 GiB layer stack, so there is nothing to gain from Standard.
#
# The name cannot be more descriptive: ACR names are alphanumeric only, no
# hyphens, and globally unique — hence the random suffix. The tag carries the
# meaning.
resource "azurerm_container_registry" "detector" {
  name                = "cr${var.project_name}${random_string.suffix.result}"
  location            = azurerm_resource_group.analytics.location
  resource_group_name = azurerm_resource_group.analytics.name
  sku                 = "Basic"
  # No admin user: the Container App pulls with a managed identity, so there is
  # no registry password to leak into the Terraform state or into anyone's shell.
  admin_enabled = false
  tags          = merge(local.tags, { proposito = "Registro de la imagen del detector (Spark + el mismo red_point_detector.py de siempre)" })
}

# --- Build the image -------------------------------------------------------
# THE ORDERING PROBLEM: the Container App cannot reference an image that does not
# exist yet, and the image cannot be pushed to a registry that does not exist yet.
#
# The fix is to make the build a Terraform node, so the dependency edge is real:
#
#   azurerm_container_registry  ->  terraform_data.detector_image  ->  azurerm_container_app
#
# The alternative (a targeted apply of the ACR from scripts/deploy-azure.sh, then
# a build, then a full apply) was rejected: targeted applies are a smell, and it
# would leave a bare `terraform apply` (or `make infra-apply`) permanently broken,
# because it would try to create the Container App with no image behind it.
#
# The build itself runs LOCALLY (scripts/build-detector-image.sh: podman build, then
# push to the registry). The engine is the HOST's Podman — the same one that runs this
# project's distrobox — and the script reaches it with distrobox-host-exec.
#
# Building here means the image can be run and smoke-tested before it ever reaches Azure
# (`make detector-image`), and the build does not depend on an Azure-side build agent.
# The cost, stated plainly: the heavy lifting happens on this machine, so the first push
# sends ~450 MB from here. Later pushes only send the layers the registry does not have.
#
# NOT podman inside the box: rootless Podman-in-Podman has no overlay-on-overlay and
# falls back to the `vfs` storage driver, which copies the entire filesystem per layer.
# The project already rejected Docker-inside-distrobox as too fragile; that would be the
# same mistake with a different binary.
resource "terraform_data" "detector_image" {
  # Re-runs only when the image content changes (the tag IS the content hash).
  triggers_replace = {
    image = local.detector_image
  }

  provisioner "local-exec" {
    # `az` is still a hard requirement: the registry has no admin user, so the push
    # authenticates with a short-lived ARM token (`az acr login --expose-token`).
    # scripts/deploy-azure.sh checks for `az` and for an active login in its preflight.
    command = <<-CMD
      ${abspath("${path.module}/../scripts/build-detector-image.sh")} \
        ${azurerm_container_registry.detector.name} \
        ${azurerm_container_registry.detector.login_server} \
        ${local.detector_image_tag} \
        ${abspath("${path.module}/../pipeline/Dockerfile")} \
        ${abspath("${path.module}/../pipeline")}
    CMD
  }
}

# --- Pull identity ---------------------------------------------------------
# A USER-assigned identity, not a system-assigned one, and the reason is ordering
# again: a system-assigned identity only exists once the Container App has been
# created, so its AcrPull role assignment could only be made AFTER creation — and
# Container Apps validates the registry credential while creating the first
# revision, which would fail the very first apply with an image-pull error.
#
# A user-assigned identity is created first, gets AcrPull first, and the Container
# App is then created already able to pull. Same "no passwords anywhere" property,
# no chicken-and-egg.
resource "azurerm_user_assigned_identity" "detector" {
  name                = "id-${var.project_name}-detector"
  location            = azurerm_resource_group.analytics.location
  resource_group_name = azurerm_resource_group.analytics.name
  tags                = merge(local.tags, { proposito = "Identidad con la que el detector baja su imagen del registro (sin usuario ni contrasena)" })
}

resource "azurerm_role_assignment" "detector_acr_pull" {
  scope                = azurerm_container_registry.detector.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.detector.principal_id
}

# --- Logs ------------------------------------------------------------------
# Container Apps needs a log destination or the detector's stdout goes nowhere,
# and stdout is the ONLY window into a streaming query. Ingest at this volume sits
# inside the 5 GiB/month free allowance.
resource "azurerm_log_analytics_workspace" "detector" {
  name                = "log-${var.project_name}-detector"
  location            = azurerm_resource_group.analytics.location
  resource_group_name = azurerm_resource_group.analytics.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = merge(local.tags, { proposito = "Logs del detector: es la unica ventana a lo que hace la consulta de streaming" })
}

# --- Runtime ---------------------------------------------------------------

resource "azurerm_container_app_environment" "detector" {
  name                       = "cae-${var.project_name}"
  location                   = azurerm_resource_group.analytics.location
  resource_group_name        = azurerm_resource_group.analytics.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.detector.id
  tags                       = merge(local.tags, { proposito = "Entorno serverless donde corre el contenedor del detector" })
}

resource "azurerm_container_app" "detector" {
  name                         = "ca-${var.project_name}-detector"
  container_app_environment_id = azurerm_container_app_environment.detector.id
  resource_group_name          = azurerm_resource_group.analytics.name
  # Single: one revision serves at a time. There is nothing to blue/green — a
  # streaming detector with two revisions alive would double-emit red points.
  revision_mode = "Single"
  tags          = merge(local.tags, { proposito = "El detector de zonas rojas: Spark Structured Streaming, prendido/apagado con min_replicas" })

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.detector.id]
  }

  registry {
    server   = azurerm_container_registry.detector.login_server
    identity = azurerm_user_assigned_identity.detector.id
  }

  # Secrets, not plain env vars. A plain env var is readable from the portal by anyone
  # with mere READER rights on the resource; a secret is not. Both of these are keys:
  # one opens Event Hubs, the other opens the data lake.
  secret {
    name  = "eventhubs-connection-string"
    value = azurerm_eventhub_namespace_authorization_rule.app.primary_connection_string
  }

  # Needed on EVERY run, not only when archiving: the Spark checkpoint lives on ADLS.
  secret {
    name  = "datalake-access-key"
    value = azurerm_storage_account.datalake.primary_access_key
  }

  template {
    # THE DEMO SWITCH. 0 replicas = no container = $0/hour; 1 = the detector is
    # running, and it is up in SECONDS. max_replicas is 1 because the query is
    # stateful and single-node: a second replica would be a second detector
    # emitting the same red points.
    min_replicas = var.detector_running ? 1 : 0
    max_replicas = 1

    container {
      name   = "detector"
      image  = local.detector_image
      cpu    = local.detector_cpu
      memory = local.detector_memory

      dynamic "env" {
        for_each = local.detector_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "EVENTHUBS_CONNECTION_STRING"
        secret_name = "eventhubs-connection-string"
      }

      # entrypoint.sh moves this into spark-defaults.conf as
      # spark.hadoop.fs.azure.account.key.<account>.dfs.core.windows.net before the JVM
      # starts. It never reaches a command line, so it cannot leak through `ps`.
      env {
        name        = "ADLS_ACCOUNT_KEY"
        secret_name = "datalake-access-key"
      }
    }
  }

  # The image must be in the registry, and the identity must already be able to
  # pull it, before the first revision is created.
  depends_on = [
    terraform_data.detector_image,
    azurerm_role_assignment.detector_acr_pull,
  ]
}

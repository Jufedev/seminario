# The detector leaves Databricks

## Discovery — the stockout, and the `Zone` vs `Location` distinction that decides everything
*discovery · 2026-07-13*

The Databricks job never started. Every run died with:

```
CLOUD_PROVIDER_RESOURCE_STOCKOUT: The requested VM size 'Standard_D4s_v3' is
currently not available in location 'eastus2'
```

**Quota was not the problem.** `az vm list-usage -l eastus2` showed the DSv3 family at
**0 of 4 vCPUs used**. Azure simply had no D4s_v3 capacity in the region to give.

There was no fallback SKU, and the reason is the distinction that governs every SKU
decision on this subscription:

```bash
az vm list-skus -l eastus2 --resource-type virtualMachines --all \
  --query "[?name=='Standard_D4s_v3'].{t:restrictions[0].type, r:restrictions[0].reasonCode}"
```

- **`type = Zone`** → **usable**. Only zone-pinned deployments are blocked, and neither
  the VM nor Databricks pins a zone.
- **`type = Location`** → **genuinely unavailable** to this subscription.

Every other 4-vCPU SKU available in `eastus2` is `Location`-restricted for an Azure for
Students subscription. `Standard_D4s_v3` was the *only* one it could use — so a stockout
on it is unrecoverable, not an inconvenience.

**Spot would have made it worse, not better.** Spot instances run on *spare* capacity; a
stockout means there is none. And a single-node cluster is only a driver, which is
on-demand regardless.

Filtering for SKUs with *no* restrictions at all is the trap here: it hides perfectly
usable ones. `Standard_D4s_v3` and `Standard_E2s_v3` both have all three zones restricted
and both deploy fine.

## Discovery — the job never used a cluster (`num_workers = 0`)
*discovery · 2026-07-13*

Looking for a SKU to fall back to is what surfaced the real finding.

The v1 Databricks job (`infra/databricks/main.tf`, now on the `v1-databricks` branch) ran
with:

```hcl
num_workers = 0
spark_conf  = { "spark.master" = "local[*, 4]" }
```

The detector was **always a single JVM in Spark local mode**. It never used a cluster, it
never distributed a task, it never needed a worker. Databricks was an expensive,
capacity-bound wrapper around **one Python process**.

The stockout is the symptom that made us look. The discovery is that the cluster was never
needed in the first place.

That also disposes of the obvious objection: the university requires **Spark Streaming**,
not Databricks. Containerised Spark is still Apache Spark Structured Streaming, running
`pipeline/red_point_detector.py` byte for byte.

## Decision — the detector runs as a container on Azure Container Apps
*decision · 2026-07-13*

`pipeline/Dockerfile` + `infra/detector.tf`. Container Apps Consumption is serverless:
there is no VM SKU to be out of stock.

What falls out of the move, beyond "it deploys at all":

| | v1 (Databricks) | v2 (Container Apps) |
|---|---|---|
| Start/stop switch | `detector_running` → pause the job | `min_replicas` 0/1 |
| Time to running | ~5 min (job cluster boot) | seconds |
| Cost while running | ~$0.60/h | ~$0.10/h |
| Always-on cost | NAT gateway ~$0.045/h | none |
| Orphan resources | `rg-metaverso-databricks-managed` | none |
| Terraform stages | 2 | 1 |

- **The NAT gateway is gone.** Databricks' secure cluster connectivity gave the workers no
  public IP, so their only route out was a NAT gateway — which billed **~$0.045/h for as
  long as the *workspace* existed**, cluster running or not.
- **`rg-metaverso-databricks-managed` is gone.** Databricks created that resource group for
  itself; Terraform never owned it and `terraform destroy` never deleted it. Its leftovers
  (DBFS root, Unity Catalog connector) blocked the next deploy and had to be purged by hand.
- **Terraform collapses to ONE stage.** The two-stage split existed for exactly one reason:
  the `databricks` provider had to be configured with a workspace URL created in the same
  apply, and a provider cannot be configured from a resource it is creating. With Databricks
  gone, so is the constraint. `infra/databricks/` is deleted.
- **Container Apps Consumption has a free monthly grant** — 180k vCPU-s + 360k GiB-s, which
  at 2 vCPU / 4 GiB covers ~25 h of detector uptime. A demo typically costs nothing in
  detector compute.

Sizing: 2 vCPU / 4 GiB (Consumption requires 2 GiB per vCPU). `max_replicas = 1` and
`revision_mode = "Single"`, because the query is stateful and single-node — a second replica
would be a second detector emitting the same red points.

## Architecture — one Terraform stage, and the image is built inside Azure
*architecture · 2026-07-13*

**There is no Docker or Podman on the dev box**, and the project had already rejected
Docker-inside-distrobox as too fragile to depend on. The only build engine available is the
one in the cloud, so the image is built with **`az acr build`**: the context is uploaded and
built *inside* Azure.

The build is a **Terraform node** (`terraform_data.detector_image`), not a step in
`scripts/deploy-azure.sh`. That makes the ordering a real dependency edge:

```
azurerm_container_registry -> terraform_data.detector_image -> azurerm_container_app
```

The alternative — a targeted apply of the ACR from the script, then a build, then a full
apply — was rejected: it would leave a bare `terraform apply` (or `make infra-apply`)
permanently broken, because it would try to create the Container App with no image behind it.

**The image tag is the content hash** of `Dockerfile` + `red_point_detector.py` +
`entrypoint.sh`. Two consequences, both wanted: editing the detector changes the tag, so
Container Apps rolls a new revision (a mutable `:latest` would have left the old code
running); and an unchanged detector produces the same tag, so `az acr build` rebuilds
nothing and re-applying is free.

The registry uses **no admin user**: the Container App pulls with a **user-assigned** managed
identity. User-assigned and not system-assigned, again for ordering — a system-assigned
identity only exists after the app is created, so its `AcrPull` grant could only land *after*
creation, and Container Apps validates the registry credential while creating the first
revision. The very first apply would fail with an image-pull error.

## Architecture — the Kafka connector is resolved into an Ivy cache at BUILD time
*architecture · 2026-07-13*

`red_point_detector.py` sets `spark.jars.packages =
org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.1`. That is a **submit-time** config: Ivy
resolves the coordinate from Maven Central **every time the JVM starts**.

On Databricks this was free — the connector shipped with the runtime. In an ephemeral
container it would mean a runtime dependency on Maven Central, 30-60 s of startup, and a
detector that simply dies if Maven has a bad minute.

So the resolution happens during the **build**: the JARs land in `/opt/ivy` (pinned via
`spark.jars.ivy` in `spark-defaults.conf`, because the build runs as root and the detector
runs as `spark` — a `$HOME`-relative cache would be missed) and are baked into the image
layer. At run time Ivy finds the module descriptor and the artifacts already cached and
resolves offline.

Verified rather than assumed: with a cold cache and no route to Maven Central the session
fails; with the cache warmed and the same dead network it starts.

The `SPARK_KAFKA_PACKAGE` build ARG is **asserted against the detector source**. If someone
bumps the connector version in the `.py` and not in the Dockerfile, the cache would be warmed
for a package nobody asks for and the runtime would silently go back to downloading from the
internet — so the build fails loudly instead.

The same reasoning covers **`hadoop-azure:3.3.4`**, baked in for `abfss://`. Pip-installed
PySpark ships Hadoop 3.3.4 *client* libraries but **no Azure filesystem** ("No FileSystem for
scheme abfss"); Databricks only made ADLS look free because DBR shipped the JARs. The version
must match what PySpark bundles, and the build asserts that too. Only four JARs go on the
classpath, not hadoop-azure's whole transitive closure: Spark already ships its own guava,
slf4j and jackson, and a second copy of each is how you earn a `NoSuchMethodError` at 3am.

## Architecture — the Spark checkpoint lives on ADLS, and that is why HNS matters
*architecture · 2026-07-13*

An earlier draft kept the checkpoint on the container filesystem, reasoning that
`startingOffsets = "latest"` makes a fresh checkpoint resume from "now". That is fine when a
*human* restarts the detector and wrong when **Container Apps** does it: an OOM, an eviction
or host maintenance would silently drop the in-flight window state and resume at the latest
offset — a detection hole with nothing in the log to show for it.

The checkpoint is therefore on ADLS
(`abfss://avatar-events@<account>.dfs.core.windows.net/checkpoints/red-point-detector`), and
this is what `is_hns_enabled = true` is actually for: a real **hierarchical namespace gives
atomic rename**, the primitive Spark's checkpoint commit protocol is built on. Flat blob
storage cannot provide it.

**The consequence restores v1 semantics:** the checkpoint holds the Event Hubs offsets and the
aggregation state, so changing `WINDOW_DURATION`, `WINDOW_SLIDE` or the aggregation in prod
needs a checkpoint **migration**, not a delete. `make clean` is a dev-only move.
`docs/integration-contract.md` had always said this — it just became true again.
`scripts/deploy-azure.sh` warns before an apply that changes the window, because it
regenerates the calibration from `env/env.prod.example` on every deploy and the change would
otherwise slip through unnoticed.

`var.checkpoint_dir_override` is the escape hatch. The ABFS shared-key write is the one thing
in the detector's **startup** path never executed against a real HNS account, and if it fails
the detector does not start at all — a worse failure than the ephemeral checkpoint it
replaced. Overriding to a container-local path trades restart resilience back for a detector
guaranteed to boot: one flag, decided calmly, instead of editing Terraform with a jury waiting.

The storage key reaches Spark as a **Container Apps secret**, and `entrypoint.sh` appends it to
`spark-defaults.conf` before the JVM starts. Not a plain env var (readable in the portal by
anyone with Reader), and not a `spark-submit` argument (visible in `ps`).

## Bugfix — 7-day retention + `failOnDataLoss = false`
*bugfix · 2026-07-13*

A persistent checkpoint creates a landmine that an ephemeral one did not have.

Event Hubs retention defaulted to **1 day**. The detector is stopped between demos and its
checkpoint outlives the stop. So a demo run three days after the last one would find committed
offsets pointing at messages Event Hubs had **already dropped** — and Spark's Kafka source
defaults to `failOnDataLoss = true`, meaning it would **refuse to start**. Exactly when it was
needed, in front of a jury.

Two changes, on both sides of the problem:

1. **Retention is now 7 days** on all three hubs (`infra/main.tf`) — the Standard tier's
   maximum, at **no extra cost** (it is covered by the tier's included storage). It also makes
   replaying a run for the H1 measurement possible at all.
2. **`failOnDataLoss = "false"`** in `pipeline/red_point_detector.py`. The data it would be
   "losing" is avatar positions from days ago; a detector of *live* congestion has no use for
   them. Skip to the oldest offset that still exists and carry on.

Retention means it usually has nothing to survive; the flag means it survives it anyway.

## Architecture — no Event Hubs consumer groups are declared, deliberately
*architecture · 2026-07-13*

v1 declared two — `spark-detector` on `avatar-positions` and `metaverse-backend` on
`red-points` — and **nothing ever used them**:

- Spark's Kafka source does not take a group id from us. It generates its own
  (`spark-kafka-source-<uuid>`) and tracks offsets in **its checkpoint**, not in the broker.
  That is the whole design, and it is what makes the restart semantics above work at all.
- `RedPointStore` uses a **per-process ephemeral** group id (`ecci-redpoints-<pid>-<ts>`) on
  purpose, so that a server restart cannot resurrect stale red zones from a committed offset.
  Red zones are live state with a TTL.
- The analytics consumer uses `ecci-analytics`.

So the two declared groups were decoration — and the architecture diagram then repeated the
fiction as fact ("Spark consume (cg: spark-detector)"). They are deleted. The code and the
diagram now tell the same story, which is the only version worth defending.

## Decision — the kill-switch gets least privilege, and the deploy refuses to undo it
*decision · 2026-07-13*

`killswitch.ps1` now deallocates the VM and **scales the detector Container App to 0
replicas** (v1: paused the Databricks jobs) — the same switch `make detector-stop` uses. It
reaches the app through the raw ARM REST API, because an Automation Account ships with
`Az.Accounts` but **not** `Az.App`; the PATCH is a JSON Merge Patch carrying only
`properties.template.scale.minReplicas`, so it cannot mangle the image, secrets or env of the
app it is trying to save.

It runs under a **custom role with four actions**, not `Contributor`.
`rg-metaverso-analytics` now holds the container registry, the Container Apps environment and
the detector itself, so `Contributor` there would let a **webhook-reachable** identity delete
the registry, rewrite the app's image or read its secrets:

```
Microsoft.Compute/virtualMachines/read
Microsoft.Compute/virtualMachines/deallocate/action
Microsoft.App/containerApps/read
Microsoft.App/containerApps/write
```

**And `scripts/deploy-azure.sh` now refuses to `terraform apply` when the kill-switch has
fired.** The runbook scales to 0 replicas *outside* Terraform, while `terraform.tfvars` still
says `detector_running = true`. The next apply — even an innocent one to change something else
— would converge reality back to the declared state and **silently switch the spend back on**,
undoing the safety net that had just cut it. The guard aborts instead.

It does not fix it automatically, and that is the point: the kill-switch firing means the
budget ceiling was hit. A person looks at what was spent and *then* decides, explicitly, with
`make detector-start`.

## Note — `make detector-stop` is not $0/hour
*discovery · 2026-07-13*

The v1 claim was true for Databricks (pausing the job terminated the job cluster, the only
per-hour resource) and became **false** in v2. `min_replicas = 0` stops the **container**, not
the deployment. What keeps billing:

| Resource | Cost |
|---|---|
| App VM (`Standard_E2s_v3`, running) | ~$0.126/h |
| Event Hubs (Standard, 1 TU) | ~$0.015/h |
| Container registry (Basic) | ~$5/month |
| Log Analytics | by ingest (small at this volume; 5 GiB/month is free) |

≈ **$0.15/hour ≈ $3.4/day**. `./scripts/deploy-azure.sh vm-stop` removes the largest piece;
only `make deploy-down` is actually $0. Saying "$0" when it is $0.15/h is precisely how a
student credit evaporates without anyone noticing.

# Azure deployment

## Architecture — 11 internal topics consolidated into `sim-events`
*architecture · 2026-07-12*

Event Hubs **Standard caps a namespace at 10 event hubs**. The metaverse needed 13
(11 internal simulation topics + `avatar-positions` + `red-points`).

The missing topics did not degrade gracefully: when a topic could not be created, the
whole Kafka bridge fell back to local mode — which in Azure meant **no red zones at
all**, with the deployment looking healthy.

**Decision:** the 11 internal topics travel consolidated in a single physical topic,
`sim-events`, with the logical topic carried **inside** each message (`{topic, ...}`);
the consumer unwraps and re-dispatches. Three physical topics total.

Also hardened: the consumer retries before degrading to local mode, instead of
degrading on the first failure.

**Gotchas found:** kafkajs `createTopics` in batch fails as a unit — creating topics
one by one with individual error handling is what makes a partial failure visible. And
a wedged KRaft controller will accept connections while refusing to create topics,
which looks exactly like a permissions problem.

## Architecture — one-command deployment, in two Terraform stages
*architecture · 2026-07-13*

The base infrastructure was Terraform, but everything after `apply` was a manual
checklist: write `terraform.tfvars`, create a Databricks cluster by hand, upload the
detector, retype ten environment variables, remember to stop the cluster. The Databricks
step was the single manual piece **without which there are no red zones**.

**Now:** `make deploy` → `scripts/deploy-azure.sh up`. The script orchestrates Terraform,
it does not replace it; everything it creates is declarative and `make deploy-down`
removes it.

**Why two Terraform root modules.** `infra/databricks/` is separate from `infra/` because
**a provider cannot be configured from a resource created in the same apply**, and the
`databricks` provider needs the workspace URL. The script pipes stage-1 outputs into
stage-2 as generated tfvars.

**Cost model.** The detector is a *continuous* Databricks job on a single-node job
cluster. `detector_running = false` pauses it → cancels the run → terminates the cluster
→ $0/hour. `make detector-start` / `make detector-stop` are that switch. The desired
state lives in the generated tfvars (not a loose `-var`), so a redeploy cannot silently
pause a running detector.

## Bugfix — Databricks exports job env vars through bash
*bugfix · 2026-07-13*

**Databricks writes a job's `spark_env_vars` into a bash script.** Unquoted, the Event
Hubs connection string (which contains `;`) **truncates at its first semicolon** and the
remainder is interpreted as another command; `WINDOW_DURATION=10 seconds` splits into two
words.

This is why the values "work" when typed in the Databricks UI and would explode in a
naively generated job spec.

**Fix, applied on both sides:** the Terraform module quotes every exported value, and
`pipeline/red_point_detector.py` reads its environment through an `env()` helper that
strips surrounding quotes — so the same value is correct whether or not the runtime
already removed them. Verified locally with a quoted connection string and a quoted
`"10 seconds"`.

## Preflight — the two failures that leave `terraform apply` green and the app dead
*discovery · 2026-07-13*

cloud-init clones the repo over HTTPS **without credentials** to deploy the app on the
VM. Two conditions therefore break the deployment while Terraform reports success:

1. **A private repo** → the clone fails inside the VM → the web server comes up empty.
2. **An unpushed HEAD** → the VM deploys *stale code* from GitHub, not the working copy.

`scripts/deploy-azure.sh` hard-fails on both before spending any credits (`--force`
overrides). Optional ADLS archiving is off by default for a related reason: without a
storage credential on the cluster, the archive stream fails on its first batch and takes
the red-point stream down with it (`awaitAnyTermination`).

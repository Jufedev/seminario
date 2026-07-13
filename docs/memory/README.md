# Project memory

Decision log and technical context for the seminario project, exported from the
working memory used during development so it lives in the repository and survives
across machines.

Source: real-time red-point detection over a Three.js metaverse, feeding an Azure
big-data pipeline (Kafka + Spark). Grade project, Universidad ECCI (Bogotá).

## Index

| File | Topic |
|------|-------|
| [00-project-context.md](00-project-context.md) | Goal, architecture, budget, hypothesis, constraints |
| [01-conventions.md](01-conventions.md) | Documentation log convention, tooling rules |
| [02-dev-environment.md](02-dev-environment.md) | Distrobox setup, native Kafka, Spark-in-container bugfix |
| [03-local-pipeline.md](03-local-pipeline.md) | Kafka + Spark detector + simulator design and validation |
| [04-infra-terraform.md](04-infra-terraform.md) | Azure Terraform stack and Well-Architected hardening |
| [05-metaverse-integration.md](05-metaverse-integration.md) | Metaverse ↔ pipeline bridge, mapping, review fixes |
| [06-status-and-plan.md](06-status-and-plan.md) | Day-1 status review, closing plan, session summary |
| [07-git-and-remote.md](07-git-and-remote.md) | Repository init and PDF history purge |
| [08-v2-integration.md](08-v2-integration.md) | v2 metaverse integration, restructure, review fixes, first tests |
| [09-detection-tuning.md](09-detection-tuning.md) | The poisoned-checkpoint outage, the live-queue calibration, metricsOnly |
| [10-azure-deployment.md](10-azure-deployment.md) | `sim-events` consolidation, one-command deploy, the Databricks bash-quoting trap |
| [11-container-detector.md](11-container-detector.md) | The Databricks stockout, the `num_workers = 0` discovery, the detector moves to Container Apps |

Each entry keeps its original date and type (decision / architecture / discovery /
bugfix / pattern) so the reasoning behind each choice stays traceable.

> **This is a log, not a description of the present.** Entries are historical: they
> record what was decided *on that date* and are never rewritten. Some entries describe
> an architecture that no longer exists (the v1 Python bridge, a 6×6 zone grid, the
> Databricks detector that entry 11 replaces) — that is the point of a log. For **what is
> true today**, read
> [`../como-funciona.md`](../como-funciona.md) (concepts and how it works) and
> [`../integration-contract.md`](../integration-contract.md) (the formal contract).

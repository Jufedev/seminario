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

Each entry keeps its original date and type (decision / architecture / discovery /
bugfix / pattern) so the reasoning behind each choice stays traceable.

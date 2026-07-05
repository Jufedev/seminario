# Azure infrastructure (Terraform)

## Hardened Terraform per Well-Architected review
*decision · 2026-07-03*

Reviewed `infra/` against the Azure Well-Architected Framework. Verdict: a
deliberate profile — cost and operations maximized, security and reliability at a
documented academic minimum.

**Three fixes applied to `infra/main.tf`:**
1. `locals.tags` `{project, environment, managed_by, workload}` on the resource
   group, Event Hubs namespace, storage account, and Databricks workspace.
2. `minimum_tls_version = "1.2"` on Event Hubs + `min_tls_version = "TLS1_2"` on
   storage.
3. `allow_nested_items_to_be_public = false` on storage.

**Full stack (prior in this topic):** Event Hubs Standard (1 TU) with
`avatar-positions` / `red-points` hubs, consumer groups, an app-access auth rule;
ADLS Gen2; Databricks standard; a $50 budget alert. `azurerm ~> 4.0` needs
`ARM_SUBSCRIPTION_ID`. Not yet applied (no subscription active).

**Also decided:** the Three.js metaverse integration would be done by the team
themselves once the teammate handed over the code — no separate integration
contract document was expected from that session (this later changed; see
`05-metaverse-integration.md`, where a contract was in fact produced).

**Where:** `infra/main.tf`, `documentacion-ia-azure.md` section 15.

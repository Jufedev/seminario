# Conventions

## Convention — maintain `documentacion-ia-azure.md` prompt/output log
*pattern · 2026-07-03*

Prompts and AI outputs that shaped the **documented architecture** are appended to
`documentacion-ia-azure.md`, following the university PDF format: section title,
`### Prompt` (verbatim user text as a blockquote), `### Output IA` (the
substantive answer). The file opens with an APA-style citation:
*Anthropic. (2026). Claude (Fable 5).*

**Scope — documentational, not operational** *(clarified 2026-07-13)*: only the
exchanges that produced the architecture and its rationale belong in that log. Day-to-day
operational work — deploying, tuning, fixing, refactoring, reviewing docs — does NOT go
in it, even though it is AI-assisted. The log is the university's record of how the
architecture was reasoned, not a transcript of the development.

So the log ending at section 15 is **not a gap to backfill**. Its technical decisions
live in this bitácora (`docs/memory/`) instead, which is what that directory is for.

**Why:** the university requires documenting the AI prompts referenced in the
grade project, in the same format as the existing PDF "info IA - Seminario - Big
data.pdf".

**How to apply:** after each substantive exchange, append a new numbered section.
Content in neutral/professional Spanish (de-personalized from chat tone).

**Also decided:** dev workflow = local Kafka/Spark for development, then Terraform
to deploy real Azure (Event Hubs Kafka endpoint + Databricks) at the end. Azure
subscription activation deferred until the architecture is built. Managed Event
Hubs chosen over a self-hosted Kafka container (cost, ops, security, deadline).

## Tooling rules
*config · 2026-07-04*

- Work happens inside the distrobox; the host is bare by design.
- Use `bun`, not `npm`, for the JS metaverse.
- Modern CLI tools (eza/fd/bat) are absent inside the box; `rg` is the one
  available.

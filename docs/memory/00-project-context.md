# Project context and constraints

## Project context — metaverse traffic simulation with Azure real-time analytics
*architecture · 2026-07-03*

Grade project (Universidad ECCI, Bogotá): "Detección de comportamientos
relevantes de usuarios en metaversos a través de Big Data en tiempo real". Team
of 4 students, each with an institutional email.

**Architecture.** A web metaverse built with Three.js (a teammate owns it). The
UI lets the user pick point A and point B on a map, choose a number of avatars
(cars), and the avatars travel the optimal route. The simulation randomly
generates blocking events → avatars get stuck → a "red point" appears → the
optimal route is recalculated.

**Azure side (this owner's responsibility).** Ingest avatar movement data
(position/state streaming), run big-data analytics to DETECT the red point (many
avatars stationary for X time in a zone = blockage event), and send that event
back to the metaverse so routes are recalculated.

**Mandatory concepts from the university:** Stream Processing, Apache Kafka,
Spark Streaming, Apache Flink, real-time processing. Problem question: "¿Cómo
analizar eventos de usuarios en tiempo real para detectar comportamientos
relevantes?"

**Hypothesis (H1):** streaming detects the blockage in time to reroute users
before they hit it. Dependent variables: detection time, reroute efficacy, event
identification.

**Budget:** estimated ~800 USD Azure (4 members × 200). Azure free trial is
$200 / 30 days with a credit card; Azure for Students is $100 / 12 months with an
institutional email. Credits cannot be pooled across subscriptions.

## Constraint — 15-day deadline, no Azure subscriptions activated yet
*discovery · 2026-07-03*

As of 2026-07-03 the team had NOT activated any Azure subscription (no Students,
no trial). Hard deadline: ~15 days (≈ July 18, 2026).

This shapes every architecture decision: favor fast-to-provision managed services
(Event Hubs Kafka endpoint + Databricks Spark) over self-managed clusters; Flink
is likely covered as a documented technical comparison rather than a live
deployment.

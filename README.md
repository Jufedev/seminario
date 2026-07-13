# Seminario — Detección de comportamientos relevantes en metaversos con Big Data en tiempo real

Proyecto de grado (Universidad ECCI, Bogotá). Un metaverso web en Three.js simula
el tránsito de muchos avatares por una ruta; cuando aparece un bloqueo, una
arquitectura de **streaming (Kafka + Spark)** detecta la congestión en tiempo real
y recalcula rutas antes de que la mayoría de los usuarios queden atrapados.

**Hipótesis (H1):** la arquitectura de streaming detecta el bloqueo con la
oportunidad suficiente para rerutear. El Big Data es el **detector de récord**;
el metaverso es la fuente de datos y el renderizador.

## Arquitectura

```
Navegador (cliente delgado)        Servidor autoritativo (Node/bun)        Spark
  render world_snapshot  ◄──WS──   corre la simulación  ── produce ──►  avatar-positions
        ▲                          (20 Hz tick, rooms)                        │ detecta
        │                                                                     ▼
     rz (zonas Spark) ◄──WS──  RedPointStore  ◄── consume ◄──────────────  red-points
```

- **Servidor autoritativo:** el servidor corre TODA la simulación; los navegadores
  solo renderizan lo que reciben. Es la única fuente de verdad de las posiciones,
  lo que da un punto limpio para producir a Kafka.
- **Sin bridge:** el servidor habla Kafka nativo (kafkajs); produce
  `avatar-positions` y consume `red-points` directamente.
- **Detección solo en Big Data:** la detección interna del metaverso está
  desconectada; las zonas rojas provienen de Spark. Contrato completo en
  [`docs/integration-contract.md`](docs/integration-contract.md).

## Estructura del repositorio

```
metaverse/        Metaverso Three.js — fuente de datos + render (corre con bun)
  server/         Servidor autoritativo + puente Kafka (avatar-positions / red-points)
  src/            Cliente del navegador (render, red, vistas) — solo modo online
pipeline/         Big Data — el detector Spark (red_point_detector.py)
infra/            Terraform (Azure: Event Hubs + Databricks + ADLS + VM) — entorno productivo
  databricks/     2ª etapa: el job de Spark dentro del workspace
env/              Perfiles de entorno: env.dev.example · env.prod.example
scripts/          kafka-local.sh (Kafka nativo) · dev-up.sh (loop local) · deploy-azure.sh (Azure)
tests/            Test de la lógica de detección
docs/             Contrato de integración, bitácora de decisiones, diagramas
```

## Requisitos

Todo corre dentro del **distrobox `seminario`** para no ensuciar el host. El
manifiesto `distrobox.ini` lo recrea con Java 17, Python y bun (no se instala
node: el servidor Node corre con bun).

## Puesta en marcha (entorno de desarrollo)

**1. Crear y entrar a la caja** (desde el host):

```bash
distrobox assemble create --file distrobox.ini    # o: make box
distrobox enter seminario
```

**2. Seleccionar el perfil de entorno e instalar dependencias** (dentro de la caja):

```bash
cp env/env.dev.example .env
make setup              # venv + pyspark
make kafka-install      # descarga Kafka + formatea storage (primera vez)
make metaverse-install  # bun install del metaverso (primera vez)
```

**3. Levantar el loop completo** (una terminal por comando):

```bash
make kafka-start        # broker Kafka en localhost:9092
make detector           # detector Spark (CELL_SIZE=75 por defecto)
make metaverse-server   # servidor autoritativo + puente Kafka
make metaverse-web      # cliente del navegador (Vite vía bun)
```

Abrir el navegador, crear o entrar a una sala e iniciar la simulación. Al
formarse una congestión, Spark publica en `red-points`, el servidor la propaga y
la zona se pinta de rojo con recálculo de rutas.

> Sin Spark corriendo no hay zonas rojas — es intencional: la detección vive en
> el Big Data. Para inspeccionar los topics: `make consume TOPIC=avatar-positions`
> o `make consume TOPIC=red-points`.

**Alternativa Docker para Kafka** (si preferís no usar el Kafka nativo):

```bash
make docker-kafka-up    # levanta Kafka vía metaverse/docker-compose.yml
```

## Validar la lógica de detección sin Kafka

```bash
make test
```

Ejecuta `detect_red_points()` en modo batch con tres escenarios: 6 avatares
detenidos en una celda (debe detectarse), 4 detenidos (bajo el umbral, no debe),
5 en movimiento (no debe).

## Entorno de producción (Azure)

El mismo código corre contra Azure — un solo comando lo despliega entero:

```bash
make deploy            # infra + app en la VM + job del detector (Databricks)
make detector-start    # enciende el detector para la demo
make detector-stop     # apagalo al terminar (es lo único que cobra por hora)
```

`infra/` provisiona el endpoint Kafka de Event Hubs, Databricks (Spark), ADLS, la
red y la VM que sirve el metaverso; `infra/databricks/` define el job de Spark.
Event Hubs expone el protocolo Kafka, así que ni el detector ni el metaverso
cambian una línea: solo `KAFKA_BOOTSTRAP` + `EVENTHUBS_CONNECTION_STRING`.

Detalle del ciclo de vida, costos y verificación: [`infra/README.md`](infra/README.md).

## Documentación

- [`docs/integration-contract.md`](docs/integration-contract.md) — topics, esquemas, coordenadas, env
- [`docs/memory/`](docs/memory/) — bitácora de decisiones técnicas (con fechas y tipo)
- `documentacion-ia-azure.md` — registro de prompts/outputs de IA (formato ECCI)

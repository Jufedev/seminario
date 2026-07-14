# Contrato de integración: metaverso ↔ pipeline de puntos rojos

Este documento define el contrato formal entre el metaverso Three.js
(`metaverse/`, servidor autoritativo Node ejecutado con bun) y el detector Spark
(`pipeline/red_point_detector.py`). Es la referencia única para topics, esquemas
JSON, mapeo de coordenadas, cadencia de emisión y variables de entorno. El mismo
código corre en local y en Azure: solo cambian variables de entorno.

> ¿Buscás **entender** el sistema en vez de consultar un campo exacto? Empezá por
> [`como-funciona.md`](como-funciona.md): explica los conceptos (streaming, Kafka,
> ventanas, watermark) y el porqué de cada decisión. Este documento es la referencia
> normativa; ese otro es la explicación.

## Principio rector

El **Big Data es el detector de récord**. El metaverso es la FUENTE de datos
(la simulación) y el renderizador; NO detecta los puntos rojos. La detección de
congestión que el metaverso trae internamente (`src/analytics/zones.js`) está
**desconectada a propósito**: corre en modo `metricsOnly` —calcula un índice de
congestión para el panel del admin— y **no** alimenta el overlay ni el recálculo de
rutas. Las zonas rojas que ve el usuario y que disparan el rerouteo provienen
exclusivamente del topic `red-points` que emite Spark.

No hay bridge: el servidor Node ya habla el protocolo Kafka de forma nativa
(kafkajs), así que produce y consume directamente contra el mismo broker que el
detector.

## Flujo completo

```
Navegador (cliente delgado)        Servidor autoritativo (Node/bun)        Spark
  render world_snapshot  ◄──WS──   corre la simulación  ── produce ──►  avatar-positions
        ▲                          (20 Hz tick, rooms)                        │ detecta
        │                                                                     ▼
     rz (zonas Spark) ◄──WS──  RedPointStore  ◄── consume ◄──────────────  red-points
```

El servidor muestrea posiciones por avatar a **1 Hz** y las produce a
`avatar-positions`. Spark detecta y emite a `red-points`. El `RedPointStore` del
servidor consume `red-points`, mapea el centro a una zona de la grilla 16×13 y la
propaga a los navegadores en el campo `rz` del `world_snapshot`, penalizando
aristas y recalculando rutas de los avatares en camino.

## Ruta rápida (loop completo en local, dentro del distrobox)

Un solo comando levanta el loop completo: **`make dev`** (Kafka → detector → servidor
→ cliente; Ctrl-C baja todo). Equivale a, en cuatro terminales:

1. `make kafka-start` — broker Kafka en `localhost:9092`
2. `make detector` — detector Spark, celdas de 30×30 ancladas en `(-240,-195)`
3. `make metaverse-server` — servidor autoritativo (produce y consume Kafka)
4. `make metaverse-web` — cliente del navegador (Vite vía bun)
5. Abrir el navegador, crear/entrar a una sala e iniciar la simulación
6. Verificación: al formarse una congestión, Spark publica en `red-points`, el
   servidor la propaga y la zona se pinta de rojo en el navegador con recálculo
   de rutas

> Nota: sin Spark corriendo NO hay zonas rojas — es intencional. La detección
> vive en el Big Data; si no está, no se detecta (esa es justamente la
> hipótesis H1 que el proyecto mide).

## Topics del contrato

| Topic | Transporte | Productor | Consumidor | Contenido |
|---|---|---|---|---|
| `avatar-positions` | Kafka | servidor metaverso | detector Spark | Posición por avatar, ~1 msg/s por avatar |
| `red-points` | Kafka | detector Spark | servidor metaverso (`RedPointStore`) | Celdas con ≥ N avatares detenidos con permanencia media ≥ `MIN_MEAN_DWELL_S` |

Los demás topics del metaverso (`agent.spawn`, `agent.reroute`, `agent.arrived`,
`incident.start/end`, `route.decision`, `analytics.snapshot`, …) son internos de
la simulación y NO forman parte de este contrato. En el cable viajan
**consolidados en un único topic físico `sim-events`** (cada mensaje lleva su
topic lógico en el campo `topic`): Event Hubs Standard limita el namespace a 10
event hubs, así que los topics físicos totales son solo 3 (`sim-events` +
`avatar-positions` + `red-points`).

El detector archiva de forma **opcional** el feed histórico de `avatar-positions`
(todas las posiciones parseadas) a Parquet cuando `ARCHIVE_PATH` está definido:
directorio local en dev (`./archive`), ruta `abfss://…` de ADLS en prod. El mismo
código sirve para ambos entornos; con `ARCHIVE_PATH` vacío no se archiva.
Está **apagado por defecto** en los dos perfiles (en Azure se enciende con
`ENABLE_ARCHIVE=true` en el despliegue) porque el stream del archivo comparte
`awaitAnyTermination()` con el de zonas rojas: si el archivo falla en su primer
batch, se lleva puesto al detector.

### Retención y pérdida de datos

En Azure los tres hubs tienen **retención de 7 días** (el máximo del tier Standard,
sin costo extra) y el detector lee con **`failOnDataLoss = false`**.

Las dos cosas responden al mismo problema: el checkpoint de Spark **persiste** entre
demos (vive en ADLS, ver [Variables de entorno](#variables-de-entorno)) pero Event Hubs
**borra** los mensajes al vencer la retención. Con una retención corta, una demo hecha
días después de la anterior encontraría offsets confirmados apuntando a mensajes que ya
no existen — y Spark, con su default `failOnDataLoss = true`, **se negaría a arrancar**.
La retención larga hace que casi nunca pase; el flag hace que, si pasa, el detector salte
al offset más viejo que exista y siga (posiciones de hace días no le sirven a un detector
de congestión viva).

## Esquemas JSON

### 1. Entrada del detector: `avatar-positions`

Producido por el servidor (`metaverse/server/simulation.js`, muestreo por avatar):

```json
{
  "room": "ECCI-1234",
  "avatar_id": "ECCI-1234-3f-42",
  "x": -104.50,
  "y": 152.00,
  "speed": 0.12,
  "ts": "2026-07-07T12:00:00.000Z"
}
```

| Campo | Origen | Transformación |
|---|---|---|
| `avatar_id` | código de sala + epoch de la sala + índice de agente | `` `${room}-${epoch}-${agentIndex}` `` (unicidad entre salas y entre reusos de un mismo código) |
| `x` | `posX[i]` | Sin cambio (unidades de mundo Three.js) |
| `y` | `posZ[i]` | Plano de suelo Three.js: `z` → `y` del detector |
| `speed` | desplazamiento medido | **`hypot(Δx,Δz)·4 / Δt`** (m/s reales entre muestras), NO la velocidad deseada |
| `ts` | reloj del servidor | `new Date().toISOString()` (ISO-8601 UTC) |

> **Velocidad medida, no deseada.** Un auto encolado detrás de un bloqueo debe
> reportar ~0. La simulación mantiene además una velocidad **deseada** por agente
> (`speed[i]`, a la que el auto *quiere* ir), y emitir esa cegaría el filtro
> `speed < 0.5` del detector: un auto trabado sigue queriendo ir rápido. Por eso el
> servidor guarda `_lastEmitX/Z/_time` por agente y calcula el desplazamiento real;
> la primera muestra cae a `speed[i]·4`.

El envelope del productor agrega `room` y un `ts` epoch, pero el payload se expande
al final, así que **el `ts` ISO gana** (deliberado: el detector necesita event-time
ISO-8601, no epoch). `room` sí lo usa el detector: agrupa por sala.

> No hay proceso puente. El servidor Node produce a Kafka de forma nativa (kafkajs);
> `KafkaBridge` es una CLASE en proceso, no un servicio aparte.

### 2. Salida del detector: `red-points`

Incluye `room`: el detector agrupa por `(room, celda)`, así que cada punto rojo
lleva la sala en la que se detectó. Un mensaje sin `room` (envelope ausente) forma
un único grupo con `room` nulo, y el servidor lo trata como global. La `key` de
Kafka es `room_cell_x_cell_y` para que salas distintas no colisionen:

```json
{
  "room": "ECCI-1234",
  "cell_x": -3, "cell_y": 2,
  "center_x": -187.50, "center_y": 150.00,
  "stationary_avatars": 7,
  "mean_dwell_s": 18.4,
  "window_start": "2026-07-07 12:00:00",
  "window_end": "2026-07-07 12:00:30"
}
```

Semántica de detección: una celda es punto rojo cuando, dentro de la ventana
deslizante, hay ≥ `MIN_STATIONARY_AVATARS` avatares distintos con
`speed < SPEED_THRESHOLD` **y** la permanencia media (`mean_dwell_s` = muestras
detenidas por avatar ≈ segundos, a 1 Hz) alcanza `MIN_MEAN_DWELL_S`.

El requisito de permanencia distingue congestión real de frenadas de semáforo: sin
él, el conteo de avatares distintos — monotónico dentro de la ventana — convertía
cualquier semáforo con flujo normal en zona roja permanente. Los valores concretos
de la ventana y los umbrales NO son los del código: ver
[Variables de entorno](#variables-de-entorno).

El servidor (`metaverse/analytics/redPoints.js`) usa solo `center_x`/`center_y`:
`zoneIndexAt(center_x, center_y)` → índice de zona 16×13 (0..207) para el overlay.
Mantiene un mapa zona→expiración con **TTL de 15 s**, refrescado por las
re-emisiones de Spark (modo `update`).

## Mapeo de coordenadas y CELL_SIZE

- Se transmiten **unidades de mundo reales** (1 unidad ≈ 4 m), sin normalización.
  Coordenadas negativas son válidas: `floor()` produce celdas negativas en el
  detector.
- Límites del mapa (`metaverse/src/graph/mapData.js`, `MAP_BOUNDS`):
  x ∈ [−225, 225] (450 unidades), z ∈ [−180, 180] (360 unidades).
- **`CELL_SIZE_X=30`, `CELL_SIZE_Y=30`, ancladas en `(-240,-195)`** (defaults de
  `make dev`/`make detector`): la MISMA grilla 16×13 del overlay del metaverso
  (`metaverse/src/analytics/config.js`), anclada a mitad de manzana para que
  ningún eje de vía caiga sobre un borde de celda. Son variables de entorno del
  detector — no están fijas en código.
- El `RedPointStore` no depende de `CELL_SIZE`: mapea el `center_x`/`center_y`
  que envía Spark a la zona 16×13 que lo contiene vía `zoneIndexAt`. Con la
  grilla espejada, celda del detector y zona del overlay coinciden 1:1.

## Correlación con salas (rooms)

El detector agrupa por `(room, celda)`: cada sala se detecta de forma
independiente, así que salas simultáneas no mezclan su congestión. El campo
`room` del envelope del productor viaja en el esquema y se emite en cada
`red-point`; mensajes sin `room` (null) forman un único grupo y el servidor los
trata como **globales** (visibles para todas las salas). La `key` de Kafka incluye
la sala (`room_cell_x_cell_y`) para que los puntos rojos por sala se particionen
distinto.

## Regla de cadencia

- El servidor muestrea posiciones por avatar a **1 Hz**, la cadencia para la que
  se diseñó el pipeline. Nunca por frame (el tick de simulación corre a 20 Hz,
  pero solo cada ~1 s se emite a Kafka).
- Se emite solo para avatares activos (MOVING/WAITING/STUCK), nunca para
  ARRIVED ni slots sin spawnear.

## Variables de entorno

> ⚠️ **El detector NUNCA corre con los defaults del código.** Los perfiles de entorno
> los sobreescriben con la calibración validada. Si sacás conclusiones leyendo los
> defaults de `red_point_detector.py`, estás mirando valores que nadie usa.

| Componente | Variable | Default en código | **Perfil calibrado (lo que corre)** | Significado |
|---|---|---|---|---|
| Detector y metaverso | `KAFKA_BOOTSTRAP` | `localhost:9092` | igual en dev; `<ns>…:9093` en Azure | Broker Kafka |
| Detector y metaverso | `EVENTHUBS_CONNECTION_STRING` | (vacío) | solo en Azure | Si se define → SASL_SSL / `$ConnectionString` contra Event Hubs |
| Detector | `CELL_SIZE_X` / `CELL_SIZE_Y` | `100` / `100` | **`30` / `30`** | Tamaño de celda (espejo exacto del overlay 16×13) |
| Detector | `GRID_ORIGIN_X` / `GRID_ORIGIN_Y` | `0` / `0` | **`-240` / `-195`** | Ancla de la grilla, a media manzana (ver §Mapeo) |
| Detector | `WINDOW_DURATION` / `WINDOW_SLIDE` | `30 seconds` / `10 seconds` | **`10 seconds` / `5 seconds`** | Ventana deslizante — **la variable experimental de H1** |
| Detector | `MIN_STATIONARY_AVATARS` | `5` | **`7`** | Avatares distintos detenidos para declarar punto rojo (una cola típica ocupa 6-9 por celda) |
| Detector | `MIN_MEAN_DWELL_S` | `12` | **`5`** | Permanencia media mínima (s) por avatar; excluye frenadas de semáforo |
| Detector | `SPEED_THRESHOLD` | `0.5` | `0.5` (no se sobreescribe) | Velocidad (m/s) bajo la cual un avatar cuenta como detenido |
| Detector | `WATERMARK_DELAY` | `30 seconds` | `30 seconds` (no se sobreescribe) | Tolerancia a eventos tardíos antes de cerrar una ventana |
| Detector | `CHECKPOINT_DIR` | `./checkpoints/red-point-detector` | **`abfss://avatar-events@<cuenta>.dfs.core.windows.net/checkpoints/red-point-detector`** | Dónde Spark guarda offsets + estado de las ventanas. En Azure lo inyecta Terraform (ver abajo) |
| Detector | `ARCHIVE_PATH` | (vacío) | (vacío = archivado APAGADO; con `ENABLE_ARCHIVE=true` → `abfss://avatar-events@<cuenta>.dfs.core.windows.net/positions`) | Si se define → archiva `avatar-positions` parseado a Parquet (dir local en dev, ADLS en prod) |
| Detector (solo en Azure) | `ADLS_ACCOUNT` / `ADLS_ACCOUNT_KEY` | — | inyectadas por Terraform (la clave, como *secret*) | No las lee el detector sino `pipeline/entrypoint.sh`: Hadoop pide la credencial de ADLS como *Spark conf*, no como variable de entorno |

**Fuente única de verdad de la calibración: `env/env.prod.example`.** Los perfiles se
activan con `cp env/env.dev.example .env` (el `Makefile` los carga con `-include .env`),
y `scripts/deploy-azure.sh` **lee ese mismo archivo** para calibrar el contenedor del
detector (genera `infra/detector.auto.tfvars` en cada deploy) — así el detector de Azure
no puede quedar desalineado del overlay del metaverso.

> ⚠️ **El checkpoint de Spark es persistente, también en Azure.** Vive en ADLS
> (`abfss://…`, sobre una cuenta con namespace jerárquico: el **rename atómico** es la
> primitiva sobre la que está construido el commit del checkpoint, y un blob plano no la
> tiene). Cambiar `WINDOW_DURATION`, `WINDOW_SLIDE` o la agregación **invalida el
> checkpoint**: el detector falla al arrancar o —peor— queda mudo sin error obvio.
>
> En dev se arregla con `make clean`. **En prod NO se borra alegremente**: ahí viven los
> offsets de Event Hubs, así que un cambio de ventana pide una **migración**, no un
> borrado. `scripts/deploy-azure.sh` compara la ventana nueva contra la última desplegada
> y **avisa antes de aplicar**.
>
> Escape hatch: `checkpoint_dir_override` (Terraform) lleva el checkpoint a un path local
> del contenedor. Vuelve efímero el estado — el detector arranca seguro, pero pierde los
> offsets en cada reinicio.

## Paridad dev ↔ prod (Azure)

| Componente | Local (distrobox) | Producción (Azure) | Qué cambia |
|---|---|---|---|
| Broker | Kafka nativo `localhost:9092` | Event Hubs `<ns>.servicebus.windows.net:9093` SASL_SSL | `KAFKA_BOOTSTRAP` + `EVENTHUBS_CONNECTION_STRING` |
| Detector | `make detector` (Spark local) | **Contenedor en Azure Container Apps** (el MISMO `.py`, copiado byte a byte en la imagen) | Solo variables de entorno |
| Checkpoint | directorio local (`./checkpoints/…`) | ADLS (`abfss://…`) | `CHECKPOINT_DIR` |
| Metaverso | `make metaverse-server` + `make metaverse-web` | VM Ubuntu: nginx sirve el cliente buildeado (`:80`), systemd corre el servidor (`:8080`) | `KAFKA_BOOTSTRAP`/`EVENTHUBS_*` (inyectadas por cloud-init) |

**El detector es el mismo `pipeline/red_point_detector.py` en los dos entornos.** En Azure
corre dentro de un contenedor (`pipeline/Dockerfile`) que trae PySpark 3.5.1, el conector de
Kafka ya resuelto y el driver de ADLS — sigue siendo **Apache Spark Structured Streaming**,
en modo local, que es como corrió siempre (ver
[`como-funciona.md` §7.1](como-funciona.md#71-por-qué-el-detector-no-corre-en-un-cluster)).
El interruptor de la demo es `min_replicas` (0 = apagado, 1 = prendido) y el contenedor
levanta en segundos.

Todo el despliegue está automatizado: `make deploy` (ver [`../infra/README.md`](../infra/README.md)).

## Checklist de verificación

- [ ] `make test` pasa (lógica de detección pura, sin Kafka) y `make metaverse-test` pasa (seams JS)
- [ ] `make metaverse-server` conecta al broker y pre-crea los 3 topics físicos
      (`sim-events`, `avatar-positions`, `red-points`); el log debe decir `kafka:kafka`, no `kafka:local`
- [ ] `make consume TOPIC=avatar-positions` muestra el esquema del pipeline (un mensaje por avatar)
- [ ] Con una congestión formada, `make consume TOPIC=red-points` muestra el punto rojo y la zona se pinta en el navegador con recálculo de rutas

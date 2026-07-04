# Contrato de integración: metaverso ↔ pipeline de puntos rojos

Este documento define el contrato formal entre el metaverso Three.js
(`desarrollo/ecci-metaverse`), el bridge WebSocket↔Kafka (`backend/bridge.py`)
y el detector Spark (`analytics/red_point_detector.py`). Es la referencia
única para topics, esquemas JSON, mapeo de coordenadas, cadencia de emisión y
variables de entorno. El mismo código corre en local y en Azure: solo cambian
variables de entorno.

## Flujo completo

```
Navegador (Three.js)                Bridge                       Spark
  agent.position ──── WebSocket ──► mapea ── produce ──► avatar-positions
  (por avatar, 1 Hz)                                             │ detecta
                                                                 ▼
  zone.red ◄──────── WebSocket ──── mapea ◄─ consume ◄─── red-points
  (source: pipeline)
```

## Ruta rápida (loop completo en local)

1. `make kafka-start` — broker Kafka en `localhost:9092`
2. `make detector` — detector Spark, CELL_SIZE=38 por defecto (terminal 1)
3. `make bridge` — bridge WebSocket↔Kafka en `ws://localhost:8765` (terminal 2)
4. `make metaverse-install` (primera vez) y `make metaverse` (terminal 3)
5. Crear `desarrollo/ecci-metaverse/.env` con `VITE_BRIDGE_WS_URL=ws://localhost:8765`
   (ver `env.example`)
6. En la vista de configuración del metaverso, elegir
   **Detección de zonas rojas: Pipeline (Spark vía bridge)** e iniciar la simulación
7. Verificación: el log del bridge muestra `clients=1` y `inbound=... ev/s`;
   al formarse una congestión, `Red point relayed: cell=(...)` y la zona se
   pinta de rojo en el navegador con recálculo de rutas

## Topics

| Topic | Transporte | Productor | Consumidor | Contenido |
|---|---|---|---|---|
| `agent.position` | WebSocket (navegador → bridge) | producer.js | bridge | Posición por avatar, ~1 msg/s por avatar |
| `avatar-positions` | Kafka | bridge | detector Spark | Esquema del pipeline (abajo) |
| `red-points` | Kafka | detector Spark | bridge | Celdas con ≥ N avatares detenidos |
| `zone.red` (source `pipeline`) | WebSocket (bridge → navegadores) | bridge | metaverso | Punto rojo en coordenadas de mundo |

Otros topics del metaverso (`agent.spawn`, `agent.reroute`, `agent.arrived`,
`incident.start`, `incident.end`, `zone.red` local, `zone.clear`,
`analytics.snapshot`, `route.computed`) llegan al bridge y se ignoran de forma
segura (se registran una vez en modo debug). **Trabajo futuro: archivado a
ADLS** de estos topics para análisis histórico.

## Esquemas JSON

### 1. Envelope del metaverso: `agent.position` (por avatar)

Emitido por `src/sim/agents.js` solo en modo live (bridge conectado):

```json
{
  "topic": "agent.position",
  "session_id": "3f9c2a71-8f2e-4c14-9d4d-0a1b2c3d4e5f",
  "ts": 1751630400000,
  "agent_id": 42,
  "x": -104.5,
  "z": 152.0,
  "speed_mps": 3.25
}
```

Nota: existe además una muestra agregada legada bajo el mismo topic (campos
`moving`/`waiting`/`stuck`, sin `agent_id`); el bridge la descarta porque no
es mapeable al esquema del pipeline.

### 2. Entrada del detector: `avatar-positions`

Producido por el bridge (`backend/mapping.py: map_agent_position`):

```json
{
  "avatar_id": "a1b2c3d4-42",
  "x": -104.5,
  "y": 152.0,
  "speed": 3.25,
  "ts": "2025-07-04T12:00:00.000+00:00"
}
```

| Campo pipeline | Origen en el envelope | Transformación |
|---|---|---|
| `avatar_id` | `session_id` + `agent_id` | `sha1(session_id)[:8] + "-" + agent_id` (unicidad entre sesiones) |
| `x` | `x` | Sin cambio (unidades de mundo) |
| `y` | `z` | Plano de suelo Three.js: z → y del detector |
| `speed` | `speed_mps` | Sin cambio (m/s) |
| `ts` | `ts` (epoch ms) | ISO-8601 UTC |

### 3. Salida del detector: `red-points`

Sin cambios respecto al detector (código intacto):

```json
{
  "cell_x": -3, "cell_y": 2,
  "center_x": -95.0, "center_y": 95.0,
  "stationary_avatars": 7,
  "window_start": "2025-07-04 12:00:00",
  "window_end": "2025-07-04 12:01:00"
}
```

### 4. Mensaje WebSocket hacia los navegadores: `zone.red`

Producido por el bridge (`backend/mapping.py: map_red_point`):

```json
{
  "topic": "zone.red",
  "source": "pipeline",
  "cell_x": -3, "cell_y": 2,
  "center_x": -95.0,
  "center_z": 95.0,
  "cell_size": 38.0,
  "stationary_avatars": 7,
  "window_start": "2025-07-04 12:00:00",
  "window_end": "2025-07-04 12:01:00"
}
```

`source: "pipeline"` distingue estos eventos del `zone.red` local que emite
`zones.js`. El mapeo inverso de coordenadas es `center_y` (detector) →
`center_z` (mundo Three.js).

## Mapeo de coordenadas y CELL_SIZE

- Se transmiten **unidades de mundo reales** (1 unidad ≈ 4 m), sin
  normalización. Coordenadas negativas son válidas: `floor()` produce celdas
  negativas en el detector.
- Límites del mapa (`src/graph/mapData.js`, `MAP_BOUNDS`):
  x ∈ [−180, 200] (380 unidades), z ∈ [−80, 200] (280 unidades).
- **`CELL_SIZE=38` recomendado**: 380 / 38 = 10 columnas y 280 / 38 ≈ 7 filas,
  es decir una grilla ~10×7 sobre el mapa (comparable a la grilla local 6×6 de
  `zones.js`). Es una variable de entorno del detector y del bridge — no está
  fija en código:

```bash
make detector   # el Makefile fija CELL_SIZE=38 por defecto; el bridge usa el mismo default
```

Importante: el detector y el bridge deben usar el **mismo** `CELL_SIZE`. El
bridge lo incluye en `cell_size` como metadato informativo: hoy el navegador
**no** lo usa para dimensionar la zona — `src/analytics/pipeline.js` solo usa
`center_x`/`center_z` y pinta/penaliza la zona local 6×6 (~63×47 unidades) que
contiene ese centro, es decir un área mayor que la celda detectada
(aproximación documentada; trabajo futuro: pintar la celda exacta).

## Regla de throttling

- El metaverso emite `agent.position` por avatar cada
  `SIM_CONFIG.POSITION_EMIT_MS = 1000` ms (~1 msg/s por avatar), la cadencia
  para la que se diseñó el pipeline. Nunca por frame.
- La emisión por avatar solo ocurre en modo live (bridge conectado); en modo
  simulado se omite para no inundar la consola.
- Si el WebSocket se desconecta, los eventos se **descartan** (no se encolan);
  el producer reintenta la conexión con backoff exponencial (1 s → 15 s).

## Modo de detección (variable experimental H1)

En la vista de configuración del metaverso:

| Modo | Comportamiento |
|---|---|
| `local` (default) | Zonas rojas calculadas en el navegador (`zones.js`); la app funciona standalone |
| `pipeline` | El flag local se desactiva; las zonas rojas llegan solo desde Spark vía el bridge y expiran a los 30 s sin re-emisión |

En ambos modos el mecanismo de aplicación es el mismo (`zones.js`): penalización
de aristas para Dijkstra, invalidación de caché de rutas y recálculo de los
avatares en camino.

## Variables de entorno por componente

| Componente | Variable | Default | Significado |
|---|---|---|---|
| Metaverso (Vite) | `VITE_BRIDGE_WS_URL` | (sin definir) | URL del bridge; sin definir = modo simulado |
| Bridge | `BRIDGE_HOST` / `BRIDGE_PORT` | `0.0.0.0` / `8765` | Dirección del servidor WebSocket |
| Bridge | `KAFKA_BOOTSTRAP` | `localhost:9092` | Broker Kafka |
| Bridge | `INPUT_TOPIC` / `OUTPUT_TOPIC` | `avatar-positions` / `red-points` | Topics Kafka |
| Bridge | `CELL_SIZE` | `38` | Debe coincidir con el del detector |
| Bridge | `EVENTHUBS_CONNECTION_STRING` | (vacío) | Si se define → SASL_SSL contra Event Hubs |
| Detector | `CELL_SIZE` | `100` en código; `make detector` fija `38` | Debe coincidir con el del bridge |
| Detector | `KAFKA_BOOTSTRAP`, `EVENTHUBS_CONNECTION_STRING`, etc. | ver README-local.md | Sin cambios |

## Paridad dev ↔ prod (Azure)

| Componente | Local (distrobox) | Producción (Azure) | Cambia |
|---|---|---|---|
| Broker | Kafka nativo `localhost:9092` | Event Hubs (endpoint Kafka) `<ns>.servicebus.windows.net:9093` SASL_SSL | Solo `KAFKA_BOOTSTRAP` + `EVENTHUBS_CONNECTION_STRING` |
| Detector | `make detector` (Spark local) | Databricks (mismo job) | Solo variables de entorno |
| **Bridge** | `make bridge` → `ws://localhost:8765` + Kafka `localhost:9092` | Container Apps → `wss://<app>.azurecontainerapps.io` + Event Hubs `9093` | Solo `VITE_BRIDGE_WS_URL` (frontend) y `KAFKA_BOOTSTRAP`/`EVENTHUBS_CONNECTION_STRING` (bridge) |
| Metaverso | `make metaverse` (Vite dev) | Hosting estático | Solo `VITE_BRIDGE_WS_URL` en build |

## Checklist de verificación

- [ ] `python3 tests/test_bridge_mapping.py` pasa (mapeo puro, sin Kafka)
- [ ] `make bridge` registra `Bridge listening on ws://0.0.0.0:8765`
- [ ] Con la simulación corriendo en modo `pipeline`, el bridge registra `inbound=... ev/s`
- [ ] `make consume TOPIC=avatar-positions` muestra el esquema del pipeline
- [ ] Al congestionar una zona, el bridge registra `Red point relayed` y la zona se pinta de rojo en el navegador

## Trabajo futuro

- Archivado a ADLS de los demás topics del metaverso (`agent.spawn`,
  `incident.*`, `analytics.snapshot`, …) para análisis histórico. En el MVP
  solo `agent.position` fluye hacia Kafka.

# Contrato de integración: metaverso ↔ pipeline de puntos rojos

Este documento define el contrato formal entre el metaverso Three.js
(`metaverse/`, servidor autoritativo Node ejecutado con bun) y el detector Spark
(`pipeline/red_point_detector.py`). Es la referencia única para topics, esquemas
JSON, mapeo de coordenadas, cadencia de emisión y variables de entorno. El mismo
código corre en local y en Azure: solo cambian variables de entorno.

## Principio rector

El **Big Data es el detector de récord**. El metaverso es la FUENTE de datos
(la simulación) y el renderizador; NO detecta los puntos rojos. La detección de
congestión que el metaverso trae internamente (`src/analytics/zones.js`) queda
**desconectada**: su código permanece, pero ya no alimenta el overlay ni el
recálculo de rutas. Las zonas rojas que ve el usuario y que disparan el
rerouteo provienen exclusivamente del topic `red-points` que emite Spark.

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
servidor consume `red-points`, mapea el centro a una zona 6×6 y el servidor la
propaga a los navegadores en el campo `rz` del `world_snapshot`, penalizando
aristas y recalculando rutas de los avatares en camino.

## Ruta rápida (loop completo en local, dentro del distrobox)

1. `make kafka-start` — broker Kafka en `localhost:9092`
2. `make detector` — detector Spark, `CELL_SIZE=75` por defecto (terminal 1)
3. `make metaverse-server` — servidor autoritativo + puente Kafka (terminal 2)
4. `make metaverse-web` — cliente del navegador (Vite vía bun) (terminal 3)
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
| `red-points` | Kafka | detector Spark | servidor metaverso (`RedPointStore`) | Celdas con ≥ N avatares detenidos |

Los demás topics del metaverso (`agent.spawn`, `agent.reroute`, `agent.arrived`,
`incident.start/end`, `route.decision`, `analytics.snapshot`, …) son internos de
la simulación y NO forman parte de este contrato. **Trabajo futuro: archivado a
ADLS** de esos topics para análisis histórico.

## Esquemas JSON

### 1. Entrada del detector: `avatar-positions`

Producido por el servidor (`metaverse/server/simulation.js`, muestreo por avatar):

```json
{
  "avatar_id": "ECCI-1234-42",
  "x": -104.50,
  "y": 152.00,
  "speed": 0.12,
  "ts": "2026-07-07T12:00:00.000Z"
}
```

| Campo | Origen | Transformación |
|---|---|---|
| `avatar_id` | código de sala + índice de agente | `` `${room}-${agentIndex}` `` (unicidad entre salas) |
| `x` | `posX[i]` | Sin cambio (unidades de mundo Three.js) |
| `y` | `posZ[i]` | Plano de suelo Three.js: `z` → `y` del detector |
| `speed` | desplazamiento medido | **`hypot(Δx,Δz)·4 / Δt`** (m/s reales entre muestras), NO la velocidad deseada |
| `ts` | reloj del servidor | `new Date().toISOString()` (ISO-8601 UTC) |

> **Velocidad medida, no deseada.** Un auto encolado detrás de un bloqueo debe
> reportar ~0. Emitir `speed[i]` (la velocidad objetivo) cegaría el filtro
> `speed < 0.5` del detector — es el error crítico corregido en la integración v1
> y trasladado aquí. El servidor guarda `_lastEmitX/Z/_time` por agente y calcula
> el desplazamiento real; la primera muestra cae a `speed[i]·4`.

El envelope del puente Kafka agrega `room` y un `ts` epoch, pero el payload se
expande al final, así que el `ts` ISO gana; el campo `room` extra lo ignora el
esquema del detector.

### 2. Salida del detector: `red-points`

Sin cambios respecto al detector (código intacto):

```json
{
  "cell_x": -3, "cell_y": 2,
  "center_x": -187.50, "center_y": 150.00,
  "stationary_avatars": 7,
  "window_start": "2026-07-07 12:00:00",
  "window_end": "2026-07-07 12:01:00"
}
```

El servidor (`metaverse/analytics/redPoints.js`) usa solo `center_x`/`center_y`:
`zoneIndexAt(center_x, center_y)` → índice de zona 6×6 (0..35) para el overlay.
Mantiene un mapa zona→expiración con **TTL de 30 s**, refrescado por las
re-emisiones de Spark (modo `update`).

## Mapeo de coordenadas y CELL_SIZE

- Se transmiten **unidades de mundo reales** (1 unidad ≈ 4 m), sin normalización.
  Coordenadas negativas son válidas: `floor()` produce celdas negativas en el
  detector.
- Límites del mapa (`metaverse/src/graph/mapData.js`, `MAP_BOUNDS`):
  x ∈ [−225, 225] (450 unidades), z ∈ [−180, 180] (360 unidades).
- **`CELL_SIZE=75` por defecto**: 450 / 75 = 6 columnas, alineando la
  granularidad de detección con la grilla 6×6 del overlay (`zones.js`). Es una
  variable de entorno del detector — no está fija en código.
- El `RedPointStore` no depende de `CELL_SIZE`: mapea el `center_x`/`center_y`
  que envía Spark a la zona 6×6 que lo contiene vía `zoneIndexAt`, es decir pinta
  la zona contenedora (aproximación documentada; trabajo futuro: pintar la celda
  exacta).

## Correlación con salas (rooms)

El detector agrupa por celda de mundo sobre **todos** los avatares y descarta el
`avatar_id`, por lo que `red-points` no lleva sala. Como todas las salas renderizan
el **mismo mapa físico**, el `RedPointStore` modela las zonas rojas como
**globales**: un único conjunto que reciben todas las salas. Para el escenario de
demostración (una sala) es exacto. *Mejora posible para multi-sala:* que el
detector parsee la sala desde `avatar_id` y agrupe por `(sala, celda)`.

## Regla de cadencia

- El servidor muestrea posiciones por avatar a **1 Hz**, la cadencia para la que
  se diseñó el pipeline. Nunca por frame (el tick de simulación corre a 20 Hz,
  pero solo cada ~1 s se emite a Kafka).
- Se emite solo para avatares activos (MOVING/WAITING/STUCK), nunca para
  ARRIVED ni slots sin spawnear.

## Variables de entorno

| Componente | Variable | Default | Significado |
|---|---|---|---|
| Detector y metaverso | `KAFKA_BOOTSTRAP` | `localhost:9092` | Broker Kafka (o `<ns>.servicebus.windows.net:9093` en Azure) |
| Detector y metaverso | `EVENTHUBS_CONNECTION_STRING` | (vacío) | Si se define → SASL_SSL / `$ConnectionString` contra Event Hubs |
| Detector | `CELL_SIZE` | `75` (`make detector`) | Tamaño de celda del grid |
| Detector | `SPEED_THRESHOLD` | `0.5` | Velocidad (m/s) bajo la cual un avatar cuenta como detenido |
| Detector | `MIN_STATIONARY_AVATARS` | `5` | Avatares detenidos para declarar punto rojo |
| Detector | `WINDOW_DURATION` / `WINDOW_SLIDE` | `60s` / `10s` | Ventana deslizante |

Los perfiles listos están en `env/env.dev.example` y `env/env.prod.example`
(`cp env/env.dev.example .env`); el `Makefile` los carga con `-include .env`.

## Paridad dev ↔ prod (Azure)

| Componente | Local (distrobox) | Producción (Azure) | Qué cambia |
|---|---|---|---|
| Broker | Kafka nativo `localhost:9092` | Event Hubs `<ns>.servicebus.windows.net:9093` SASL_SSL | `KAFKA_BOOTSTRAP` + `EVENTHUBS_CONNECTION_STRING` |
| Detector | `make detector` (Spark local) | Databricks (mismo job) | Solo variables de entorno |
| Metaverso | `make metaverse-server` + `make metaverse-web` | Hosting del cliente + servidor en Container Apps | `KAFKA_BOOTSTRAP`/`EVENTHUBS_*` (servidor) |

## Checklist de verificación

- [ ] `make test` pasa (lógica de detección pura, sin Kafka)
- [ ] `make metaverse-server` conecta al broker y pre-crea `avatar-positions` / `red-points`
- [ ] `make consume TOPIC=avatar-positions` muestra el esquema del pipeline (un mensaje por avatar)
- [ ] Con una congestión formada, `make consume TOPIC=red-points` muestra el punto rojo y la zona se pinta en el navegador con recálculo de rutas

## Trabajo futuro

- Archivado a ADLS de los demás topics del metaverso para análisis histórico.
- Detección por sala (agrupar por `(sala, celda)` en el detector).
- Re-alimentar el heatmap del panel de administración desde `red-points` (hoy el
  heatmap interno quedó en 0 al desconectar `zones.update`).

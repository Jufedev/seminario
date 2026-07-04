# Entorno local de desarrollo — Pipeline de detección de puntos rojos

Pipeline de analítica en tiempo real ejecutado 100% en local, sin costo de Azure.
El mismo código corre luego contra Azure Event Hubs + Databricks cambiando solo
variables de entorno.

```
producer.py ──► Kafka (topic: avatar-positions) ──► red_point_detector.py (Spark)
(simulador)                                              │
                                                         ▼
consumer.py ◄── Kafka (topic: red-points) ◄──────────────┘
(backend simulado)
```

## Requisitos

- Docker + Docker Compose
- Python 3.10 a 3.12 (PySpark 3.5 NO soporta 3.13+; crear el venv con una versión soportada)
- Java 17 (lo necesita PySpark): `java -version` para verificar

## Puesta en marcha

**1. Levantar Kafka** — dos opciones según el entorno:

**Opción A — Todo dentro de Distrobox, sin Docker (recomendada para este equipo):**

```bash
make kafka-install   # solo la primera vez (descarga + formatea storage)
make kafka-start
make kafka-status    # debe listar "Kafka is UP"
```

Kafka corre nativo (KRaft single-node) en `localhost:9092`. Para inspeccionar
un topic sin Kafka UI: `make consume TOPIC=red-points`.

`make help` lista todos los comandos disponibles.

**Opción B — Docker Compose (si Docker está disponible en el host):**

```bash
make docker-up
```

- Kafka queda en `localhost:9092`
- Kafka UI (para inspeccionar topics y mensajes): http://localhost:8080
- Floci (emulador de Azure, se usará en la fase de Terraform): `localhost:4577`

Ambas opciones exponen el mismo `localhost:9092`; el resto de los pasos es
idéntico. Nota: Floci solo está disponible en la Opción B — la emulación de
Terraform puede hacerse más adelante con podman en el host, o validarse
directamente con `terraform plan` contra Azure real.

**2. Instalar dependencias de Python**:

```bash
make setup
```

**3. Arrancar el detector de puntos rojos** (terminal 1):

```bash
make detector
```

La primera ejecución descarga el conector de Kafka para Spark (tarda un poco).

**4. Arrancar el consumidor de eventos** (terminal 2):

```bash
make consumer
```

**5. Arrancar el simulador de avatares** (terminal 3):

```bash
make producer
```

## Qué se debe observar

1. El simulador mueve 50 avatares de A(0,0) a B(1000,1000).
2. A los 20 segundos se activa un bloqueo en el punto medio (500,500): los
   avatares que llegan ahí quedan detenidos (`stuck` crece en el log).
3. Cuando ≥5 avatares llevan detenidos en la misma celda del mapa dentro de la
   ventana de 60 s, Spark publica el evento al topic `red-points`.
4. El consumidor imprime `NEW RED POINT` con la celda y el centro de la zona
   bloqueada — este es el evento que el backend del metaverso usará para
   recalcular rutas.

## Validar la lógica de detección sin Docker

La lógica del punto rojo se puede probar sin levantar Kafka (solo requiere
Python soportado + Java):

```bash
make test
```

El test ejecuta `detect_red_points()` en modo batch con tres escenarios:
6 avatares detenidos en una celda (debe detectarse), 4 detenidos (bajo el
umbral, no debe), y 5 en movimiento (no debe).

## Parámetros de detección (variables de entorno)

| Variable | Default | Significado |
|---|---|---|
| `CELL_SIZE` | 100 | Tamaño de la celda del grid del mapa |
| `SPEED_THRESHOLD` | 0.5 | Velocidad bajo la cual un avatar cuenta como detenido |
| `MIN_STATIONARY_AVATARS` | 5 | Avatares detenidos necesarios para declarar punto rojo |
| `WINDOW_DURATION` | 60 seconds | Tamaño de la ventana deslizante |
| `WINDOW_SLIDE` | 10 seconds | Cada cuánto se evalúa la ventana |
| `AVATAR_COUNT` | 50 | Avatares simulados (producer) |
| `BLOCKAGE_START_S` | 20 | Segundo en que se activa el bloqueo (producer) |

## Cambio a Azure (fase final)

El mismo detector corre contra Azure Event Hubs definiendo:

```bash
export KAFKA_BOOTSTRAP="<namespace>.servicebus.windows.net:9093"
export EVENTHUBS_CONNECTION_STRING="Endpoint=sb://..."
```

No se modifica ninguna línea de código: Event Hubs expone el protocolo Kafka.

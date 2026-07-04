# DOCUMENTACIÓN IA — ARQUITECTURA AZURE Y ANALÍTICA EN TIEMPO REAL

Registro de prompts y outputs de IA utilizados para el diseño de la arquitectura de datos del proyecto.

Anthropic. (2026). *Claude* (Fable 5) [Modelo de lenguaje de gran escala]. https://claude.ai

---

## 1. CONTEXTO INICIAL Y PROPUESTA DE ARQUITECTURA

### Prompt

> Te deje un pdf de mi proyecto de grado, la idea es emplear azure para la analitica de datos, montar un servidor donde corra el metaverso con la simulacion y tener esos datos almacenados, somos 4 integrantes en mi grupo, cada uno con un correo institucional entonces diria que podemos tener 800 usd en azure para este proyecto, el metaverso estara montado en navegador por threejs (actualmente un compañero esta trabajando en este). Para darte mas contexto, mi compañero ha montado una interfaz para escoger un punto a y un punto b, se selecciona la cantidad de "avatares" (que son carros) y van de ese punto a al punto b por lo que es la ruta mas optima, el metaverso genera aleatoriamente eventos que hacen trancar a los avatares esto genera un punto rojo y dado ese punto rojo se recalcula la ruta optima. Lo que quiero de ti en esta sesion es que me ayudes con todo lo de azure, necesito tomar los datos de movimiento de los avatares para hacer la bigdata y calcular el punto rojo (que seria el calculo del evento de acuerdo a los avatares, si hay muchos avatares quietos por cierto tiempo en una zona determinada eso seria un punto rojo) para que le envie este evento al metaverso y se recalcule la ruta "mas optima". Te deje un pdf en el folder para que tengas mas contexto de lo que llevamos

### Output IA

#### Corrección sobre el presupuesto

El cálculo de 800 USD parte de un supuesto incorrecto (verificado contra documentación oficial de Microsoft):

- **Azure for Students** (correo institucional, sin tarjeta): **$100 USD por persona, válidos 12 meses** → son **$400**, no $800.
- El trial de **$200** existe, pero **requiere tarjeta de crédito y expira a los 30 días**. Para un proyecto de grado que dura meses, sirve poco.
- Los créditos **NO se pueden juntar**: son 4 suscripciones separadas, 4 billeteras independientes. La infraestructura vive en una suscripción y esa billetera es la que se consume.

$100–200 alcanzan si la arquitectura es inteligente. El error clásico es dejar clusters prendidos 24/7 — eso es lo que consume créditos, no el proyecto en sí.

#### Arquitectura propuesta

El pipeline mapea los conceptos obligatorios de la universidad:

```
Three.js (navegador)
   │ posiciones de avatares (WebSocket)
   ▼
Backend del metaverso (App Service / Container Apps)
   │ produce eventos vía protocolo Kafka
   ▼
Azure Event Hubs (endpoint Kafka)          ← "Apache Kafka" ✓
   │
   ▼
Spark Structured Streaming (Databricks)    ← "Spark Streaming" ✓
   │  ventana deslizante: N avatares con velocidad ≈ 0
   │  por T segundos en la misma celda del mapa → PUNTO ROJO
   ├──► ADLS Gen2 (histórico crudo = "Big Data")
   ▼
Event Hub de salida (topic "red-points")
   │
   ▼
Backend → WebSocket → Three.js recalcula la ruta
```

Tres decisiones clave:

1. **Event Hubs en vez de Kafka autogestionado**: Event Hubs habla protocolo Kafka nativo, así que en el documento de grado es legítimamente "Apache Kafka", pero cuesta ~$11/mes en tier Standard en vez de mantener un cluster.
2. **Databricks solo prendido en demos**: un cluster single-node de Spark cuesta ~$0.50/hora. Se prende para desarrollar y demostrar, se apaga al terminar. El gasto mensual real queda en decenas de dólares.
3. **Flink**: correrlo administrado en Azure (HDInsight on AKS) es caro para el presupuesto. Recomendación: cubrirlo en el documento como comparación técnica evaluada (Spark vs Flink), o correrlo en un container si el jurado exige verlo en vivo.

La detección del punto rojo es una agregación con ventana: se divide el mapa en celdas (grid), se agrupan avatares por celda cada 10–30 segundos, y si hay más de N quietos por más de T segundos → evento. Simple, medible, y entrega directamente las variables dependientes de la hipótesis (tiempo de detección, eficacia del recálculo).

Fuentes: [Azure for Students](https://azure.microsoft.com/en-us/free/students), [What is Azure for Students? — Microsoft Learn](https://learn.microsoft.com/en-us/azure/education-hub/about-azure-for-students), [Azure Free Trial](https://azure.microsoft.com/en-us/pricing/purchase-options/azure-account)

---

## 2. EXPLICACIÓN DE CONCEPTOS: STREAM PROCESSING, KAFKA, SPARK, FLINK

### Prompt

> no, no hemos activado ninguna suscripcion de azure y tengo 15 dias para realizar el proyecto, quisiera que me explicaras ya que tienes todo el contexto, el tema de los conceptos/tecnologias que se me propone para desarrollar esto (flink, kafka, etc)

### Output IA

#### El problema de fondo: batch vs streaming

La analítica "clásica" (batch) funciona así: se acumulan datos, y cada cierto tiempo corre un proceso que los analiza todos juntos. En el proyecto: los avatares mandan posiciones, se guardan, y cada 10 minutos un job pregunta "¿hubo trancones?".

El problema: para cuando el job corre, **los avatares ya están metidos en el trancón hace 9 minutos**. La respuesta llega tarde y ya no sirve. La propia justificación del proyecto lo dice: si se recalcula la ruta después de que la mayoría quedó atrapada, la solución perdió su propósito.

**Stream processing** invierte la lógica: en vez de "guardar y después analizar", los datos se analizan **mientras fluyen**, evento por evento. El análisis está siempre corriendo, y los datos pasan a través de él. Eso es "procesamiento en tiempo real". Todo lo demás (Kafka, Spark, Flink) son las piezas que hacen esto posible.

#### Apache Kafka — el sistema circulatorio

Kafka **no analiza nada** (malentendido común). Kafka es el transporte: un log distribuido donde los **productores** escriben eventos y los **consumidores** los leen, organizados en **topics** (canales con nombre).

En el proyecto:

- El backend del metaverso es el **productor**: cada avatar publica `{avatarId, x, y, velocidad, timestamp}` al topic `avatar-positions`, aproximadamente cada segundo.
- El motor de análisis es el **consumidor**: lee ese flujo continuamente.

¿Por qué no mandar los datos directo del metaverso al motor de análisis? Tres razones:

1. **Desacople**: si el motor de análisis se cae o se reinicia, los eventos no se pierden — quedan en Kafka esperando. El metaverso no se entera.
2. **Buffer ante picos**: 500 avatares mandando posiciones por segundo es una ráfaga. Kafka absorbe el pico; el consumidor lee a su ritmo.
3. **Un flujo, muchos lectores**: el mismo topic lo puede leer Spark para detectar puntos rojos Y otro consumidor que archiva todo al storage histórico (el "big data"), sin duplicar nada.

En Azure se usa **Event Hubs**, que habla el protocolo Kafka nativamente — el código usa librerías de Kafka, en el documento es legítimamente Kafka, pero no se administra ningún cluster.

#### Spark Streaming — el cerebro (micro-batch)

Aquí sí se analiza. Spark es un motor de procesamiento distribuido, y **Spark Structured Streaming** es su modo streaming. Su mecanismo: toma el flujo continuo y lo procesa en **micro-batches** — lotes pequeños cada pocos segundos. No es evento-por-evento puro, pero logra latencias de 1–5 segundos, suficiente para este caso.

Lo que Spark aporta para el punto rojo es el concepto de **ventana de tiempo con agregación**. La detección, casi literal:

> "Del flujo de posiciones, agrupar por celda del mapa, en ventanas de los últimos 60 segundos. Si en una celda hay más de N avatares con velocidad ≈ 0 durante toda la ventana → emitir evento de punto rojo."

En Spark son ~15 líneas: un `groupBy(ventana, celda)` con un filtro de velocidad y un conteo. El resultado se publica a otro topic (`red-points`), el backend lo consume y avisa al Three.js por WebSocket. Ciclo cerrado.

#### Apache Flink — el competidor de Spark

Flink resuelve el mismo problema que Spark Streaming con una filosofía distinta: es **streaming puro** — procesa evento por evento apenas llega, sin micro-batches. Eso da latencias de milisegundos y un manejo más fino del **event time** (procesar según cuándo ocurrió el evento, no cuándo llegó — importa cuando los eventos llegan desordenados).

¿Cuándo gana Flink? Detección de fraude en pagos, trading, telemetría industrial — donde los milisegundos importan. En este caso, un trancón se define como "avatares quietos por 30–60 segundos". Detectarlo con 3 segundos de latencia o con 300 milisegundos lleva a la misma decisión. Flink no aporta ventaja aquí, y en Azure correrlo administrado es caro para el presupuesto.

Esto es una oportunidad para el documento: la universidad pide "incorporar los conceptos", no desplegar los cuatro. Un capítulo comparando Spark vs Flink que **justifique técnicamente** la elección de micro-batch para este dominio vale más ante un jurado que tener ambos corriendo sin criterio.

#### El mapa completo

| Concepto | Rol en el proyecto | En Azure |
|---|---|---|
| Stream processing | El paradigma: analizar mientras fluye, no después | Toda la arquitectura |
| Kafka | Transporte de eventos de posición, desacople y buffer | Event Hubs (endpoint Kafka) |
| Spark Streaming | Detección del punto rojo con ventanas de tiempo | Databricks |
| Flink | Alternativa evaluada; comparación justificada en el documento | (no desplegado) |
| Tiempo real | El requisito que valida la hipótesis H1 | Latencia medida end-to-end |

Bonus que conecta con la hipótesis: como la detección es una ventana configurable, se puede **medir** el tiempo entre "avatares quedaron quietos" y "evento generado" — que es literalmente la variable dependiente de H1. La arquitectura entrega la tesis de regalo.

---

## 3. SERVICIO ADMINISTRADO VS CONTAINER DE KAFKA AUTOGESTIONADO

### Prompt

> dejemos lo de la activacion de azure para cuando tengamos toda la arquitectura ya hecha, creo que podemos usar floci para emular azure para cuando ya este todo okey subamos con terraform la arquitectura a azure, tengo una duda, por que usar servicio administrado de azure en vez de montar contenedor de kafka

### Output IA

#### Sobre Floci

[Floci](https://floci.io/) es un emulador local de Azure open-source estilo LocalStack: corre en un container, [floci-az](https://github.com/floci-io/floci-az) soporta Event Hubs y se integra con Terraform apuntando a `localhost:4577`. El plan de desarrollar local y subir con Terraform al final es sólido. Dos advertencias:

1. **Databricks/Spark no está en la lista de servicios emulados.** Para la parte de Spark, el desarrollo local es Spark de verdad (PySpark local o container) — que de hecho es mejor, porque es el mismo motor que corre en Databricks.
2. **Validar si el Event Hubs de Floci expone el endpoint Kafka** (protocolo Kafka, puerto 9093), porque el código va a hablar protocolo Kafka. Si no lo expone, para desarrollo local se usa un container de Kafka real — misma fidelidad.

#### ¿Por qué Event Hubs administrado y no un container de Kafka en Azure?

El container de Kafka es gratis... hasta que tiene que correr en la nube. El costo real no es el software, es lo que viene alrededor:

**El compute.** Kafka es una JVM que requiere 1–2 GB de RAM mínimo. En Azure eso significa una VM B2s (~$30/mes) o Container Apps con memoria asignada — corriendo 24/7, porque un broker de mensajería no se puede apagar entre demos como el cluster de Spark. Event Hubs Standard cuesta ~$11/mes y no existe la pregunta "¿dónde corre?". Con $100 de crédito por persona, esa diferencia es el proyecto entero.

**Las operaciones.** Con Kafka autogestionado, el operador es el equipo: configurar KRaft, retención de logs, discos, TLS y autenticación para exponerlo a internet (el backend del metaverso tiene que alcanzarlo), reiniciarlo cuando se cae, monitorearlo. Nada de eso aporta al documento de grado, y en 15 días cada hora peleando con un broker es una hora que no está en la detección del punto rojo — que es donde vive la hipótesis.

**La seguridad.** Un Kafka expuesto a internet sin TLS/SASL bien configurado es una puerta abierta. Event Hubs da TLS y autenticación por connection string de fábrica.

¿Cuándo SÍ tiene sentido el container de Kafka en la nube? Cuando se necesitan features exactas de Kafka que Event Hubs no cubre (Kafka Streams, log compaction, transacciones exactly-once), cuando el volumen es tan alto que lo administrado sale más caro, o cuando el objetivo del proyecto ES aprender a operar Kafka. Ninguna de las tres aplica a este caso.

La jugada que une todo: **como ambos hablan protocolo Kafka, el código no distingue**. Local: container de Kafka (o Floci) en docker-compose. Azure: Terraform provisiona Event Hubs. Lo único que cambia entre ambientes es la connection string en una variable de entorno. Mismo código, cero reescritura — y en el documento queda un capítulo de "portabilidad por protocolo estándar".

Para el documento de grado esto es una decisión arquitectónica con nombre: *managed service vs self-hosted*, justificada por costo, tiempo y foco.

Fuentes: [Floci — Local Cloud Emulators](https://floci.io/), [floci-az en GitHub](https://github.com/floci-io/floci-az), [floci-az — Free Azure Emulator](https://floci.io/az/)

---

## 4. IMPLEMENTACIÓN DEL ENTORNO LOCAL DE DESARROLLO

### Prompt

> dale, sigamos

*(Continuación acordada en la interacción anterior: construir el entorno local de desarrollo — docker-compose con Floci + Kafka + Spark — para desarrollar sin costo de Azure.)*

### Output IA

Se implementó el pipeline completo de detección de puntos rojos ejecutable 100% en local, sin costo de nube. Archivos generados:

| Archivo | Rol |
|---|---|
| `docker-compose.yml` | Infraestructura local: Kafka 3.9 (modo KRaft, sin ZooKeeper), Kafka UI (inspección de topics en `localhost:8080`) y Floci (emulador de Azure para la fase de Terraform) |
| `analytics/red_point_detector.py` | Job de Spark Structured Streaming: lee `avatar-positions`, agrupa avatares detenidos (velocidad < umbral) por celda del mapa en ventana deslizante de 60 s, y publica el evento de punto rojo al topic `red-points` cuando ≥ N avatares quedan detenidos en la misma celda |
| `simulator/producer.py` | Simulador de avatares (sustituto temporal del backend del metaverso): 50 avatares viajan de A a B; a los 20 s se activa un bloqueo en el punto medio que detiene a los avatares que llegan a la zona |
| `simulator/consumer.py` | Consumidor del topic `red-points` (sustituto del backend que notificará al Three.js por WebSocket); deduplica eventos por celda |
| `README-local.md` | Instrucciones de ejecución y tabla de parámetros de detección |

Decisiones técnicas registradas:

1. **Portabilidad local → Azure por variables de entorno**: el job de Spark acepta `EVENTHUBS_CONNECTION_STRING`; si está definida, configura SASL_SSL contra Event Hubs. El mismo código corre en local (Kafka container) y en Azure (Event Hubs + Databricks) sin modificar una línea.
2. **Modo de salida `update` en Spark**: emite el punto rojo apenas se cruza el umbral, sin esperar el cierre de la ventana — menor latencia de detección (variable dependiente de la hipótesis H1). El costo es que una misma celda puede emitirse varias veces mientras crece el conteo; el consumidor deduplica por clave de celda.
3. **Detección parametrizable** (`CELL_SIZE`, `SPEED_THRESHOLD`, `MIN_STATIONARY_AVATARS`, `WINDOW_DURATION`, `WINDOW_SLIDE` como variables de entorno): permite experimentar con distintos umbrales y medir el impacto en el tiempo de detección, que es exactamente el experimento que valida o refuta la hipótesis.
4. **Watermark de 30 s**: tolerancia a eventos que llegan tarde o desordenados — concepto de *event time* discutido en la comparación Spark vs Flink.
5. **Simulador desacoplado**: permite desarrollar y demostrar la analítica sin depender del avance del metaverso; cuando el backend real exista, reemplaza al simulador publicando el mismo esquema JSON (`avatar_id, x, y, speed, ts`) al mismo topic.

---

## 5. TESTS DE VALIDACIÓN E INFRAESTRUCTURA COMO CÓDIGO (TERRAFORM)

### Prompt

> pero no lo puedo probar hasta que mi compañero me pase el codigo del mataverso con el threejs, hagamos lo que podamos hacer mientras, como validaciones de lo qeu tenemos, el codigo en terraform, etc

### Output IA

#### Corrección de un supuesto

No es necesario el código del metaverso para probar el pipeline: `simulator/producer.py` fue diseñado precisamente como sustituto del backend real — genera avatares en movimiento con el mismo esquema JSON que producirá el metaverso. El pipeline completo es probable en local desde ya; cuando el backend de Three.js exista, reemplaza al simulador publicando al mismo topic. Ese desacople (posible gracias a Kafka) elimina la dependencia entre el avance de la analítica y el avance del metaverso.

#### Test unitario de la lógica de detección

Se refactorizó `analytics/red_point_detector.py` extrayendo la detección a una función pura `detect_red_points(positions)`, ejecutable tanto en streaming como en batch (el watermark se ignora en batch). Esto permitió crear `tests/test_detection_logic.py`, que valida la lógica sin Kafka ni Docker con tres escenarios sintéticos:

1. 6 avatares detenidos en la misma celda → **debe** marcarse como punto rojo ✓
2. 4 avatares detenidos en otra celda → bajo el umbral (5), **no debe** marcarse ✓
3. 5 avatares en movimiento → no están detenidos, **no debe** marcarse ✓

Ejecución: `python tests/test_detection_logic.py` (requiere Python 3.10–3.12 y Java 17; PySpark 3.5 no soporta Python 3.13+ — restricción documentada en README-local.md).

#### Infraestructura como código (`infra/`)

Terraform con provider `azurerm ~> 4.0`:

| Recurso | Justificación | Costo |
|---|---|---|
| Event Hubs Standard, 1 TU, topics `avatar-positions` (4 particiones) y `red-points` (1 partición) | Kafka administrado; **Standard es el tier mínimo con protocolo Kafka** (Basic no lo soporta) | ~$11/mes |
| Regla de autorización namespace-level `app-access` (listen+send) | Una sola connection string para producer, Spark y consumer — suficiente para proyecto académico | — |
| Storage Account con `is_hns_enabled` + filesystem `avatar-events` | ADLS Gen2 para el archivo histórico (Big Data) | Centavos |
| Databricks workspace (SKU standard) | Ejecuta el job de Spark; $0 sin cluster corriendo | ~$0.50/h solo con cluster prendido |
| Consumption Budget con alerta al 80% de $50/mes | Protección de los créditos de estudiante | Gratis |

Outputs: `kafka_bootstrap` y `eventhubs_connection_string` (sensitive) — exactamente las dos variables de entorno que el job de Spark acepta para pasar de local a Azure sin cambiar código.

Para probar el Terraform contra Floci antes de gastar créditos: el provider azurerm descubre endpoints por HTTPS, por lo que Floci debe correr con `FLOCI_AZ_TLS_ENABLED=true`, el certificado autofirmado instalado (disponible en `/_floci/tls-cert`) y `metadata_host = "localhost:4577"` descomentado en `providers.tf`. Databricks y Budget probablemente no estén emulados — se validan con `terraform plan` contra Azure real.

Pasos manuales fuera de Terraform (documentados en `infra/README.md`): crear cluster single-node en Databricks con auto-terminate, subir el job, configurar variables de entorno, y apagar el cluster después de cada demo.

---

## 6. PROCEDIMIENTO DE VALIDACIÓN DEL PIPELINE

### Prompt

> dame el paso a paso para validar

### Output IA

Procedimiento de validación en tres fases, de menor a mayor complejidad (si una fase falla, el problema queda acotado a esa capa):

**Fase 0 — Prerequisitos**: Docker + Docker Compose, Java 17, y Python 3.12 en venv aislado (vía `uv venv --python 3.12`, dado que PySpark 3.5 no soporta Python 3.13+). Instalación de dependencias con `requirements.txt`.

**Fase 1 — Test unitario (sin Docker)**: `python tests/test_detection_logic.py`. Valida la lógica de agregación por ventana y celda con datos sintéticos. Resultado esperado: celda (5,5) marcada como punto rojo, celdas (1,1) y (7,7) no marcadas.

**Fase 2 — Pipeline end-to-end**: `docker compose up -d` y tres procesos: detector de Spark, consumidor de `red-points`, y simulador de avatares. Secuencia esperada: a t=20s se activa el bloqueo, los avatares se detienen al llegar a la zona (500,500), y entre t≈40s y t≈70s el consumidor imprime `NEW RED POINT` en la celda (4,4) o (5,5).

**Medición para la hipótesis**: la diferencia entre el instante en que el 5.º avatar queda detenido (log del simulador) y el instante en que se emite el evento (log del consumidor) es el **tiempo de detección del bloqueo** — la variable dependiente de H1, medible desde la primera corrida.

**Fase 3 — Verificación visual**: Kafka UI en `localhost:8080` permite observar los mensajes JSON en ambos topics en tiempo real (evidencia gráfica para el documento y las demos).

Solución de problemas frecuentes: eliminar `checkpoints/` al cambiar parámetros entre corridas; verificar `docker compose ps` (estado healthy); confirmar la versión de Python dentro del venv.

---

## 7. ENTORNO DE DESARROLLO AISLADO CON DISTROBOX

### Prompt

> ven podemos manejar ese proyecto en distrobox para descargar todas las dependencias en "bare metal"

### Output IA

Se adoptó Distrobox para aislar las dependencias de ejecución del sistema anfitrión, con la siguiente división de responsabilidades:

- **Dentro de la caja (Ubuntu 24.04)**: Java 17 (OpenJDK) y Python — Ubuntu 24.04 trae Python 3.12 por defecto, exactamente la versión que PySpark 3.5 requiere, eliminando la gestión manual de versiones.
- **En el host**: Docker y el `docker-compose` (Kafka, Kafka UI, Floci). Distrobox ya es un contenedor; anidar un daemon de Docker dentro agrega complejidad sin beneficio. Como Distrobox comparte la red del host, `localhost:9092` es alcanzable desde dentro de la caja sin configuración adicional. El `$HOME` compartido hace el proyecto accesible directamente.

Creación del entorno:

```bash
distrobox create --name seminario --image ubuntu:24.04
distrobox enter seminario
sudo apt update && sudo apt install -y openjdk-17-jdk python3-venv
```

Beneficio metodológico: entorno reproducible — cualquier integrante del equipo recrea el ambiente de desarrollo exacto con dos comandos, sin contaminar su sistema base.

---

## 8. BUG: SPARK DETECTA FALSAMENTE UN CONTAINER DE YARN DENTRO DE DISTROBOX

### Prompt

> python tests/test_detection_logic.py → java.lang.Exception: Yarn Local dirs can't be empty (stack trace completo adjunto)

### Output IA

**Causa raíz**: Distrobox exporta la variable de entorno `CONTAINER_ID` para identificar su propia caja. Spark usa exactamente esa variable para detectar si corre dentro de un container de YARN (`Utils.isRunningInYarnContainer`); al encontrarla definida, intenta resolver los directorios locales de YARN (`getYarnLocalDirs`), que no existen en modo local → `Yarn Local dirs can't be empty`.

**Solución aplicada**: eliminar `CONTAINER_ID` del entorno antes de inicializar la JVM de Spark, tanto en `analytics/red_point_detector.py` como en `tests/test_detection_logic.py`:

```python
os.environ.pop("CONTAINER_ID", None)
```

Con el fix en código, el pipeline funciona dentro de Distrobox sin pasos manuales. Workaround temporal equivalente: `unset CONTAINER_ID` antes de ejecutar.

**Lección documentable**: colisión de convenciones entre herramientas — dos sistemas (Distrobox y Hadoop YARN) eligieron el mismo nombre de variable de entorno con semánticas distintas. Ejemplo real de por qué los entornos de ejecución deben validarse, no asumirse.

**Resultado de la validación (Fase 1, 2026-07-03)**: test ejecutado exitosamente dentro de Distrobox tras el fix de `CONTAINER_ID`:

```
OK — detection logic behaves as expected:
  flagged cells: [(5, 5)]
  windows emitted for cell (5,5): 8
```

Las 8 ventanas emitidas confirman el comportamiento de la ventana deslizante: las muestras abarcan 20 s, y con ventana de 60 s deslizándose cada 10 s existen exactamente 8 ventanas que las contienen.

---

## 9. ENTORNO 100% DISTROBOX SIN DOCKER + MAKEFILE COMO INTERFAZ

### Prompt

> la gracia es que todo viva en distrobox, no tener docker en mi pc (esa instalacion me la salte, empece a realizar ejecucion desde la creacion del distrobox)

> usemos make porfavor

### Output IA

**Decisión**: eliminar Docker del flujo de desarrollo local. Correr un daemon de Docker dentro de Distrobox (container privilegiado dentro de un container rootless) es frágil; la alternativa correcta es reconocer que Kafka no necesita Docker: es una aplicación Java, y Java 17 ya vive en la caja.

**Implementación**:

- `scripts/kafka-local.sh` — instala y opera Apache Kafka 3.9.1 nativo en modo KRaft single-node dentro de la distrobox: descarga el tarball oficial, formatea el storage KRaft, y expone `install/start/stop/status/logs/consume`. Kafka queda en `localhost:9092`, idéntico al escenario Docker — el resto del pipeline no cambia.
- `Makefile` — interfaz única del proyecto: `make setup`, `make test`, `make kafka-start`, `make detector/consumer/producer`, `make consume TOPIC=...`, `make clean` (borra checkpoints de Spark), y `make docker-up` como alternativa para quien sí tenga Docker. `make help` autodocumentado.

**Implicación sobre Floci**: el emulador de Azure es un container; sin Docker en el flujo local queda diferido — cuando llegue la fase de Terraform, se ejecuta con podman en el host (ya presente como runtime de Distrobox) o se valida directamente con `terraform plan` contra Azure real.

**Beneficio adicional**: correr Kafka desde el tarball oficial (formatear storage, arrancar broker, usar console consumer) expone al equipo a la operación real de Kafka — conocimiento directamente citable en el marco metodológico, sin el costo de operarlo en la nube.

---

## 10. ARQUITECTURA DEL ENTORNO DE DESARROLLO LOCAL

### Prompt

> explicame como quedo la arquitectura del desarrollo local y que hace cada cosa

### Output IA

```
CachyOS (host) — sin dependencias del proyecto
│
└── Distrobox "seminario" (Ubuntu 24.04 + Java 17 + Python 3.12)
    │
    ├── Apache Kafka 3.9.1 nativo (KRaft) ──── localhost:9092
    │     ├── topic: avatar-positions   (entrada, ~50 msg/seg)
    │     └── topic: red-points         (salida, eventos de bloqueo)
    │
    ├── [make producer]  simulator/producer.py ──── escribe → avatar-positions
    ├── [make detector]  analytics/red_point_detector.py (PySpark)
    │                         lee ← avatar-positions │ escribe → red-points
    └── [make consumer]  simulator/consumer.py ──── lee ← red-points
```

**Componentes**:

- **Distrobox**: aísla Java 17 y Python 3.12 del sistema anfitrión; entorno reproducible por cualquier integrante con `distrobox create` + `make setup`.
- **Kafka (KRaft nativo, sin Docker)**: transporte de eventos. Los tres procesos de Python no se conocen entre sí — todos hablan únicamente con Kafka. Ese desacople permite reemplazar el simulador por el metaverso real sin modificar el resto.
- **producer.py** (metaverso simulado): 50 avatares de A(0,0) a B(1000,1000), una posición por avatar por segundo (`avatar_id, x, y, speed, ts`); a t=20s activa un bloqueo en (500,500) que detiene a los avatares que llegan.
- **red_point_detector.py** (núcleo analítico, Spark Structured Streaming): (1) deserializa JSON a filas tipadas, (2) filtra `speed < 0.5`, (3) mapea posición a celda de grid de 100×100 (`floor(x/100), floor(y/100)`), (4) agrupa por celda en ventana deslizante de 60 s reevaluada cada 10 s, (5) si ≥5 avatares distintos detenidos en una celda → publica el punto rojo a `red-points`. El directorio `checkpoints/` guarda offsets procesados y estado de ventanas para reanudación exactly-once (por eso debe borrarse al cambiar parámetros).
- **consumer.py** (backend simulado): escucha `red-points`, deduplica por celda e indica el punto de integración donde el backend real notificará al Three.js por WebSocket.
- **Makefile + scripts/kafka-local.sh**: fachada operativa del proyecto (`make help`).

**Equivalencia local → Azure** (misma arquitectura, costo cero en desarrollo):

| Local (distrobox) | Azure (producción) | Qué cambia |
|---|---|---|
| Kafka nativo KRaft | Event Hubs (endpoint Kafka) | Solo la connection string |
| Detector PySpark local | Mismo script en Databricks | Nada del código |
| producer.py | Backend real del metaverso | Mismo esquema JSON y topic |
| consumer.py | Backend real → WebSocket | Misma suscripción |
| `checkpoints/` en disco | Checkpoints en ADLS Gen2 | Solo la ruta |

---

## 11. REVISIÓN EN VIVO DEL PIPELINE Y HALLAZGOS

### Prompt

> puedes hacer una revision de las 3 shells para analisarlas porfavor

### Output IA

Revisión realizada inspeccionando procesos, logs del broker y contenido real de los topics (~12 minutos de ejecución):

**Estado**: broker Kafka, detector Spark, producer y consumer activos y estables. `avatar-positions`: 33,150 eventos ingresados. `red-points`: 3,846 eventos emitidos. Consumer group `metaverse-backend` estabilizado.

**Detección correcta**: los eventos recientes marcan la celda (4,4), centro (450,450) — coherente con el bloqueo en (500,500) radio 60: los avatares frenan al borde del círculo (~457,457).

**Hallazgo 1 — falso positivo en el origen**: los primeros puntos rojos fueron la celda (0,0) con 39 avatares "quietos": los avatares con salida escalonada emitían `speed=0` desde A antes de arrancar. El detector actuó correctamente; el defecto era del simulador (calidad del dato en la fuente). El mismo defecto generaría un falso positivo en el destino B con avatares llegados.

**Hallazgo 2 — conteo 49/50**: `approx_count_distinct` (HyperLogLog) intercambia ~2% de exactitud por memoria constante y velocidad en streaming — irrelevante para la decisión de trancón, relevante para el marco teórico (exactitud vs. latencia).

**Nota de producción**: los puntos rojos nunca se "resuelven" (los avatares trancados emiten indefinidamente). El evento inverso ("bloqueo despejado") queda como trabajo futuro.

---

## 12. FIX DE TELEMETRÍA Y DIAGRAMAS DE ARQUITECTURA (DRAW.IO)

### Prompt

> dale, tambien quiero que me hagas la arquitectura en drawio, quiero la arquitectura de como quedara produccion y como quedara dev/qa

### Output IA

**Fix aplicado** (`simulator/producer.py`): se agregó `Avatar.is_active()` — un avatar solo emite telemetría entre su salida y su llegada. Elimina los falsos positivos en el origen (avatares esperando salir) y en el destino (avatares llegados). El log ahora muestra `active=N` además de `stuck=N`.

**Diagramas** (`docs/arquitectura.drawio`, editable en app.diagrams.net, 2 páginas):

- **Página "Producción (Azure)"**: Navegador Three.js ↔ (WebSocket) ↔ Backend en Container Apps/App Service → produce a Event Hubs Standard (endpoint Kafka, SASL) → Databricks con Spark Structured Streaming → publica a `red-points` y archiva en ADLS Gen2 → el backend consume y empuja el recálculo al navegador. Todo dentro del resource group provisionado con Terraform, con Consumption Budget (alerta al 80% de $50/mes).
- **Página "Dev/QA (Local — Distrobox)"**: host CachyOS limpio → distrobox Ubuntu 24.04 (Java 17, Python 3.12, make) → Kafka 3.9.1 nativo KRaft con ambos topics → producer.py (metaverso simulado) → detector PySpark (+ checkpoints/) → consumer.py (backend simulado). Anotación de paridad: mismo código que producción, solo cambian `KAFKA_BOOTSTRAP` y `EVENTHUBS_CONNECTION_STRING`.

---

## 13. DIAGRAMAS DE ARQUITECTURA AUTOEXPLICATIVOS

### Prompt

> La arquitectura necesito que sea lo mas clara y esplicada posible, yo la ajusto manualmente con los iconos de sevicios, colocando lo de la suscripcion, resources groups, etc

### Output IA

Se rehizo `docs/arquitectura.drawio` con orientación autoexplicativa — cada elemento describe su rol sin necesidad de leer el documento; los íconos oficiales de servicios se agregan manualmente sobre las cajas ya posicionadas.

**Página "Producción (Azure)"** incluye: frontera de Suscripción (Azure for Students, $100/12 meses) → frontera de Resource Group (rg-metaverso, eastus2, Terraform) → servicios con descripción de rol, tier y configuración (Event Hubs Standard 1 TU con endpoint Kafka 9093/SASL_SSL; Databricks con los 4 pasos del algoritmo de detección; ADLS Gen2 con sus tres usos; Consumption Budget). Flujo numerado ①–⑦ desde el navegador Three.js hasta el recálculo de ruta. Cajas auxiliares: esquema JSON de entrada/salida, leyenda de colores, y costo mensual estimado (&lt; $25/mes típico).

**Página "Dev/QA (Local — Distrobox)"** incluye: frontera Host CachyOS → frontera Distrobox (Ubuntu 24.04, Java 17, Python 3.12) → Kafka nativo KRaft (localhost:9092 PLAINTEXT), simulador con sus reglas (salidas escalonadas, bloqueo t=20s, emisión solo de avatares activos), detector con el algoritmo, checkpoints, backend simulado. Flujo numerado ①–④, caja de paridad con producción (las 2 variables de entorno que cambian), caja de validación (make test) y anotación de medición de H1 (tiempo de detección).

---

## 14. ANÁLISIS DE ESTADO Y PLAN DE CIERRE (DÍA 1 DE 15)

### Prompt

> dale, has un analisis detallado y revisa toda la informacion que llevamos hasta el momento y dime que sigue?

### Output IA

**Completado y validado**: lógica de detección (test unitario), pipeline end-to-end local (33,150 eventos, 3,846 detecciones, celda correcta), entorno reproducible (Distrobox + Kafka nativo + Makefile), Terraform completo sin aplicar, diagramas drawio, bitácora al día, 2 bugs resueltos y documentados como hallazgos.

**Gaps identificados (por riesgo)**:
1. 🔴 Ninguna suscripción de Azure activada — único bloqueante externo; sin ella no hay evidencia cloud.
2. 🔴 Contrato de integración con el metaverso sin formalizar — el esquema JSON `{avatar_id, x, y, speed, ts}` y los topics deben comunicarse al equipo de Three.js de inmediato.
3. 🟠 Backend real (puente WebSocket ↔ Kafka) sin construir y sin responsable asignado.
4. 🟠 Archivo histórico a ADLS (el "Big Data" del título) presente en el diagrama pero no implementado (~10 líneas de writeStream adicional).
5. 🟡 Medición de H1 manual — falta script que calcule el tiempo de detección automáticamente.

**Plan de los 14 días restantes**: Días 1–2: activar suscripciones + entregar contrato de integración. Días 3–5: terraform apply, Databricks, pipeline contra Event Hubs con simulador (evidencia cloud). Días 6–9: backend real + integración Three.js (ventana más incierta, va temprano). Días 10–11: archivado a ADLS + script de medición + corridas experimentales variando parámetros. Días 12–14: documento y ensayo de demo, sin código nuevo.

---

## 15. ALINEACIÓN CON EL AZURE WELL-ARCHITECTED FRAMEWORK

### Prompt

> el codigo de terraform si se alinea con los pilares de azure?

> dale, aplicalos

### Output IA

Revisión del `infra/` contra los 5 pilares del Azure Well-Architected Framework:

| Pilar | Estado | Detalle |
|---|---|---|
| Optimización de costos | ✅ Fuerte | Standard como tier mínimo con Kafka, 1 TU, LRS, Databricks sin cluster permanente, Consumption Budget con alerta al 80% |
| Excelencia operativa | ✅ Bien | IaC con outputs que alimentan al pipeline, README como runbook; se agregaron tags de gobernanza |
| Seguridad | 🟡 Aceptable | TLS+SASL obligatorios, secrets fuera del código y sensitive en outputs; gaps conscientes de alcance académico: auth rule compartida, sin managed identities ni private endpoints |
| Confiabilidad | 🟡 Mínima deliberada | Región única y LRS (redundancia multi-región sería costo injustificado); la resiliencia real está a nivel de datos: Kafka como buffer duradero + checkpoints exactly-once |
| Eficiencia de rendimiento | ✅ Bien | Particiones dimensionadas por volumen real (4/1); micro-batch justificado por dominio (comparación Spark vs Flink) |

**Veredicto**: perfil deliberado — costos y operación al máximo, seguridad y confiabilidad al mínimo viable documentado. El framework no exige maximizar los 5 pilares sino decidir conscientemente en cada uno.

**Ajustes aplicados a `infra/main.tf`**:
1. `locals.tags` (project, environment, managed_by, workload) aplicados a resource group, Event Hubs namespace, storage account y Databricks workspace.
2. `minimum_tls_version = "1.2"` en Event Hubs namespace y `min_tls_version = "TLS1_2"` en storage account.
3. `allow_nested_items_to_be_public = false` en el storage account (sin acceso público anónimo a blobs).

**Nota**: la integración con el metaverso la realiza el equipo directamente cuando reciban el código de Three.js (decisión del equipo registrada).

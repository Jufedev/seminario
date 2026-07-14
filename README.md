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
- **Sin proceso intermedio:** el servidor habla Kafka nativo (kafkajs); produce
  `avatar-positions` y consume `red-points` directamente. No hay un servicio puente
  aparte que traducir ni desplegar.
- **Detección solo en Big Data:** la detección interna del metaverso está
  desconectada; las zonas rojas provienen de Spark. Contrato completo en
  [`docs/integration-contract.md`](docs/integration-contract.md).

## Estructura del repositorio

```
metaverse/        Metaverso Three.js — fuente de datos + render (corre con bun)
  server/         Servidor autoritativo — produce y consume Kafka (avatar-positions / red-points)
  src/            Cliente del navegador (render, red, vistas) — solo modo online
pipeline/         Big Data — el detector Spark (red_point_detector.py)
  Dockerfile      La imagen con la que el MISMO detector corre en Azure
env/              Perfiles de entorno: env.dev.example · env.prod.example
infra/            Terraform (Azure: Event Hubs + Container Apps + ADLS + VM) — entorno productivo
scripts/          kafka-local.sh (Kafka nativo) · dev-up.sh (loop local) · deploy-azure.sh (Azure)
tests/            Tests de la lógica de detección y del parseo de posiciones
docs/             Cómo funciona, contrato de integración, costos, diagramas
```

En Azure el detector corre como **contenedor** (Azure Container Apps), no en un cluster: el
volumen de datos del pipeline cabe de sobra en una sola JVM, y un cluster solo agregaría
coordinación que nadie necesita. Sigue siendo Apache Spark Structured Streaming, con el mismo
`.py` que corre en local. El porqué, desde cero, en
[`docs/como-funciona.md` §7.1](docs/como-funciona.md#71-por-qué-el-detector-no-corre-en-un-cluster).

## Requisitos

Todo corre dentro del **distrobox `seminario`** para no ensuciar el host. El
manifiesto `distrobox.ini` lo recrea con Java 17, Python, bun (no se instala
node: el servidor Node corre con bun), Terraform y el Azure CLI que necesita el despliegue.

**La única cosa que se necesita EN EL HOST es podman** — y ya está ahí, porque es el motor que
corre esta distrobox. El despliegue lo usa para construir la imagen del detector y lo alcanza
con `distrobox-host-exec`. No se instala podman *dentro* de la caja: podman-dentro-de-podman
cae al driver `vfs` y copia el filesystem entero por capa.

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
make detector           # detector Spark (celdas 30×30 ancladas en (-240,-195))
make metaverse-server   # servidor autoritativo (produce y consume Kafka)
make metaverse-web      # cliente del navegador (Vite vía bun)
```

O todo el loop de una: `make dev`.

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

Ejecuta `detect_red_points()` en modo batch con cuatro escenarios: 6 avatares
detenidos 15 s en una celda (debe detectarse), 4 detenidos (bajo el umbral, no
debe), 5 en movimiento (no debe) y 8 frenando ~2 s en un semáforo (permanencia
media insuficiente, **no debe** — es la regresión que separa congestión de
frenada normal). Corre también el test del parseo de posiciones (la costura
JS→Spark). Ninguno de los dos necesita Kafka.

## Entorno de producción (Azure)

El mismo código corre contra Azure sin cambiar una línea: Event Hubs expone el
protocolo Kafka, así que el detector y el metaverso solo cambian de
`KAFKA_BOOTSTRAP` + `EVENTHUBS_CONNECTION_STRING`. `infra/` provisiona —en **una
sola etapa de Terraform**— la red, la VM que sirve el metaverso, Event Hubs, ADLS
y el contenedor del detector (registro de imágenes + Azure Container Apps).

### Antes de desplegar (una sola vez)

1. **Suscripción activa** y sesión de Azure: `az login`.
2. **El repo tiene que ser público.** cloud-init lo clona por HTTPS **sin
   credenciales** para desplegar la app en la VM: si es privado, la VM arranca
   vacía y el `terraform apply` igual sale en verde. El preflight lo verifica.
3. **Tu HEAD tiene que estar pusheado.** La VM clona GitHub, no tu working copy:
   sin `git push` desplegarías código viejo sin enterarte. El preflight también
   lo verifica.

`terraform` y `az` ya vienen en el distrobox (ver `distrobox.ini`).

### Desplegar

```bash
make deploy
```

Un solo comando cubre todo el ciclo, sin checklists manuales:

| Paso | Qué hace |
|---|---|
| Preflight | Sesión de Azure, repo público, HEAD pusheado |
| Guard del kill-switch | Aborta si el kill-switch del presupuesto disparó (un apply lo revertiría) |
| `infra/terraform.tfvars` | Lo genera (email del presupuesto + llave SSH — la crea si no existe) |
| `infra/detector.auto.tfvars` | Calibración del detector, leída de `env/env.prod.example` |
| `terraform apply` | Red, VM, Event Hubs, ADLS, registro + **imagen del detector** (build local con podman → push al registro) + Container App **apagada**, presupuesto y kill-switch |
| `.env.azure` | Perfil listo para correr el detector/metaverso local contra Azure |
| Espera | Hasta que cloud-init termine y la web responda (~5 min) |

Al final imprime la URL del metaverso, el nombre del contenedor del detector, la
imagen y la ruta del checkpoint.

### Correr la demo

```bash
make detector-start    # detector ON — el contenedor levanta en SEGUNDOS
make deploy-status     # IP, web, VM, réplicas del detector y salud de sus revisiones
make detector-stop     # detector OFF — apagalo apenas termine la demo
```

`min_replicas` es el interruptor: 0 réplicas = no hay contenedor = el detector no
cobra. **Pero eso NO deja el gasto en $0:** siguen cobrando la VM ($0.133/h),
Event Hubs ($0.030/h), el registro ($5/mes), la IP pública ($0.005/h) y el disco —
**$0.177/h ≈ $4.25/día** en total.

```bash
./scripts/deploy-azure.sh vm-stop   # desasigna la VM (lo más caro que queda PRENDIDO)
make deploy-down                    # destruye TODO — lo único que deja el gasto en $0
```

> Ojo: después de `vm-stop` **seguís pagando $0.044/h** (~$32/mes), y ahí el mayor
> gasto pasa a ser Event Hubs, no la VM. Con el stack desplegado y ocioso, el crédito
> de $100 se agota en **23 días**. Números verificados contra la factura real y
> desglosados en [`docs/costos-azure.md`](docs/costos-azure.md).

**Verificación end-to-end:** abrir la web, crear una sala como admin, unir
usuarios con el código e invocar flotas grandes. Al formarse una cola (≥7
avatares detenidos ~5 s en una celda) la zona se pinta de roja y las rutas la
esquivan. Si no aparecen zonas rojas, el sospechoso es el detector: `make
deploy-status` muestra sus réplicas y si alguna está en crash-loop, y los logs
del contenedor traen el banner de arranque.

> Sin el detector corriendo no hay zonas rojas — igual que en dev: la detección
> vive en el Big Data.

### Destruir todo

```bash
make deploy-down
```

Detalle de recursos, costos por recurso e internals (por qué la imagen se construye
**localmente con el podman del host** y no dentro de Azure, dónde vive el checkpoint de
Spark, los límites de Azure for Students, el kill-switch del presupuesto):
[`infra/README.md`](infra/README.md).

> `make detector-image` construye la imagen del detector **sin tocar Azure** (sin push, sin
> sesión, sin registro). Sirve para probarla antes de desplegar.

## Documentación

**Si sos nuevo en el proyecto, empezá acá:**

- [`docs/como-funciona.md`](docs/como-funciona.md) — **cómo funciona y por qué**. Los
  conceptos (streaming, Kafka, ventanas, watermark, checkpoint) explicados desde cero, y
  el recorrido de un dato de punta a punta. No hace falta saber Big Data para leerlo.

Referencia:

- [`docs/integration-contract.md`](docs/integration-contract.md) — el contrato formal: topics, esquemas JSON, coordenadas, variables de entorno
- [`docs/costos-azure.md`](docs/costos-azure.md) — **la fuente de verdad de los costos**: qué se cobra, por hora, verificado contra la factura real. Leelo ANTES de dejar el stack prendido
- [`infra/README.md`](infra/README.md) — despliegue a Azure, los límites de Azure for Students, el presupuesto y el kill-switch, ciclo de la demo
- [`docs/arquitectura.drawio`](docs/arquitectura.drawio) — los diagramas (producción en Azure y entorno local)

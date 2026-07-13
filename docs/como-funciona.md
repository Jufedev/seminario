# Cómo funciona el proyecto — guía para el equipo

Esta guía es para que **cualquiera del equipo entienda el sistema completo**, incluso
sin haber tocado Kafka o Spark antes. Primero los conceptos, después el recorrido
real de un dato por nuestro código.

No hace falta leer código para entender esto. Pero después de leerlo, el código se
lee solo.

> Referencias hermanas: [`integration-contract.md`](integration-contract.md) es el
> contrato formal (esquemas exactos, campos, variables). [`memory/`](memory/) es la
> bitácora de decisiones con fechas. Esta guía es el **porqué**.

---

## 1. Qué estamos probando

**El problema:** en un metaverso con mucho tránsito, cuando se forma un bloqueo, los
avatares se van encolando. Para cuando alguien se da cuenta, ya hay veinte atrapados.

**La hipótesis (H1):** una arquitectura de **streaming** puede detectar ese bloqueo
**con la oportunidad suficiente para rerutear** a los que todavía vienen en camino.

Lo importante conceptualmente:

> **El Big Data es el detector de récord.** El metaverso NO detecta nada: es la
> **fuente de datos** (produce las posiciones) y el **renderizador** (pinta las zonas
> rojas que le mandan). Quien decide qué es una zona roja es Spark, y solo Spark.

Esto no es un detalle de implementación, es la tesis. Si el metaverso detectara por su
cuenta, no estaríamos probando nada sobre streaming — estaríamos probando un `if`. Por
eso la detección interna que el metaverso traía de fábrica está **desconectada a
propósito** (sigue calculando un índice de congestión, pero solo como métrica
informativa del dashboard; no pinta ni rerutea nada).

**Consecuencia práctica:** si Spark no está corriendo, **no hay zonas rojas**. Eso no
es un bug. Es la hipótesis funcionando.

---

## 2. Los conceptos, en orden

### 2.1 Streaming vs batch

**Batch** es "juntá todos los datos del día y procesalos a la noche". Sirve para
reportes. No sirve para nosotros: cuando el reporte esté listo, el avatar ya está
atrapado hace dos horas.

**Streaming** es "procesá cada evento apenas llega, y mantené una respuesta siempre
actualizada". El programa no termina nunca: es un bucle infinito que consume eventos y
actualiza resultados. Esa es la diferencia que hace posible H1.

### 2.2 Kafka: la cinta transportadora

Kafka es el sistema que mueve los eventos entre componentes. Vocabulario mínimo:

| Término | Qué es |
|---|---|
| **Topic** | Un canal con nombre. Nosotros usamos `avatar-positions`, `red-points`, `sim-events`. |
| **Mensaje** | Un evento: bytes con una `key` opcional y un `value` (para nosotros, JSON). |
| **Productor** | Quien escribe en un topic. El servidor del metaverso produce posiciones. |
| **Consumidor** | Quien lee de un topic. Spark consume posiciones; el servidor consume zonas rojas. |
| **Partición** | Un topic se parte en N para escalar. Kafka garantiza el orden **dentro** de una partición, no entre particiones. |
| **Offset** | La posición de lectura de un consumidor. Kafka **no borra** el mensaje cuando lo leés: solo avanzás tu offset. |
| **Consumer group** | Un conjunto de consumidores que se reparten las particiones y comparten el offset. |

Las dos ideas que hay que entender de verdad:

**Kafka desacopla.** El servidor no le habla a Spark: le habla a un topic. Spark no le
habla al servidor: lee de un topic. Ninguno de los dos sabe que el otro existe. Podés
apagar Spark, el metaverso sigue produciendo; lo prendés de nuevo y retoma.

**Kafka es un log, no una cola.** El mensaje no se consume "destructivamente": queda
ahí y cada consumidor lleva su propio offset. Por eso podés tener a Spark y a un
`make consume` leyendo lo mismo al mismo tiempo, sin robarse mensajes.

### 2.3 Event Hubs = Kafka administrado

En Azure no levantamos un cluster de Kafka: usamos **Event Hubs**, que **expone el
protocolo Kafka**. Para el código es un broker de Kafka con otra dirección y con TLS +
autenticación. Por eso **ni el detector ni el metaverso cambian una sola línea** entre
local y Azure: cambian dos variables de entorno.

> Event Hubs **Standard** es el mínimo que habla Kafka. El tier Basic no lo soporta.

### 2.4 Spark Structured Streaming: la tabla infinita

Spark es el motor que hace la detección. La abstracción central es hermosa:

> Un stream es una **tabla que nunca deja de crecer**. Escribís una consulta como si
> fuera SQL sobre una tabla normal, y Spark se encarga de re-ejecutarla incrementalmente
> a medida que llegan filas nuevas.

Nosotros escribimos "filtrá los detenidos, agrupalos por celda y ventana, contá" — y
Spark lo convierte en un proceso incremental que corre para siempre.

### 2.5 Event time vs processing time

- **Processing time**: cuándo Spark VIO el evento.
- **Event time**: cuándo el evento OCURRIÓ (el campo `ts` que puso el servidor).

Siempre agrupamos por **event time**. Si un mensaje se demora 3 segundos en la red,
igual tiene que contar en el segundo en que el avatar estuvo quieto, no en el segundo
en que Spark lo recibió. Si no, un pico de latencia te corrompe la medición.

### 2.6 Ventana deslizante (sliding window)

No preguntamos "¿cuántos avatares están quietos?" sino **"¿cuántos estuvieron quietos
en los últimos N segundos?"**. Eso es una ventana.

Con **duración 10 s** y **slide 5 s**, cada evento cae en varias ventanas solapadas:

```
tiempo →  0    5    10   15   20   25
          [ventana 1 ][────────]
               [ventana 2 ][────────]
                    [ventana 3 ][────────]
```

- **Duración** = cuánta historia mira cada ventana. Más larga = más estable, pero más
  lenta en apagar una zona ya despejada.
- **Slide** = cada cuánto se evalúa una ventana nueva. Más corto = detección más rápida,
  más cómputo.

La duración de la ventana es **la variable experimental de H1**: es exactamente el
cuchillo entre "detecto rápido" y "detecto confiable".

### 2.7 Watermark: cuándo dejar de esperar

Un evento puede llegar tarde. ¿Hasta cuándo mantenemos abierta una ventana esperando
rezagados? Para siempre no: la memoria de Spark no es infinita.

El **watermark** es esa respuesta: "aceptá eventos con hasta N segundos de atraso;
después de eso, cerrá la ventana y liberá su estado". Sin watermark, un job de
streaming con agregaciones crece en memoria hasta morir.

### 2.8 Output mode `update`

Cuando una ventana produce un resultado, ¿cuándo lo emitimos?

- `complete` — reemitir todo siempre. Caro.
- `append` — emitir **solo cuando la ventana cierra**. Correcto, pero **lento**: habría
  que esperar a que pase la ventana entera + el watermark para enterarse del bloqueo.
- **`update`** — emitir **apenas el resultado cambia**. Es el que usamos: en cuanto la
  celda cruza el umbral, sale el punto rojo. Menor latencia de detección, que es
  literalmente lo que mide la tesis.

El precio de `update`: **la misma celda se re-emite varias veces** mientras la
congestión dura. Por eso el consumidor **deduplica por `key`** y usa TTL (§3.5).

### 2.9 Checkpoint

Spark guarda su progreso (offsets de Kafka + estado de las ventanas) en un directorio de
**checkpoint**. Es lo que le permite reiniciar sin perder ni duplicar.

> ⚠️ **La trampa que más tiempo nos costó:** si cambiás los parámetros de ventana o la
> agregación, el checkpoint viejo es **incompatible** y el detector queda mudo — sin un
> error obvio. En dev: `make clean` borra los checkpoints. **En prod NO** se borra
> alegremente: ahí viven los offsets de Event Hubs.

---

## 3. El recorrido de un dato, paso a paso

Este es el sistema real, de punta a punta:

```
Navegador (cliente delgado)     Servidor autoritativo (bun)          Spark
   render world_snapshot ◄─WS─  corre TODA la simulación  ─produce─► avatar-positions
         ▲                      (tick 20 Hz, salas)                       │ detecta
         │                                                                ▼
      rz (zonas) ◄────WS──────  RedPointStore  ◄──── consume ──────── red-points
```

### 3.1 El servidor simula; el navegador solo dibuja

El servidor corre la simulación entera a **20 ticks por segundo**. Los navegadores son
**clientes delgados**: reciben un `world_snapshot` y lo renderizan. No simulan nada.

**Por qué importa:** el servidor es la **única fuente de verdad** de las posiciones. Eso
nos da un punto limpio y confiable para producir a Kafka. Si cada navegador reportara
sus propias posiciones, tendríamos datos contradictorios y manipulables.

### 3.2 Muestreo a 1 Hz (no a 20 Hz)

Aunque la simulación corre a 20 Hz, a Kafka se emite **una muestra por avatar por
segundo**. No hace falta más resolución para detectar un atasco, y a 20 Hz estaríamos
produciendo 20× de datos para la misma conclusión.

Esa cadencia de 1 Hz tiene una consecuencia elegante que aparece después: **una muestra
detenida ≈ un segundo detenido**. Guardá ese dato para §3.4.

### 3.3 La trampa de la velocidad (el bug más instructivo del proyecto)

El detector filtra por `speed < 0.5`. Pero, ¿qué velocidad emite el servidor?

La simulación tiene una velocidad **deseada** por avatar (a la que quiere ir) y una
posición real que avanza tick a tick. Un auto encolado detrás de un bloqueo **sigue
queriendo ir a 40 km/h**: su velocidad deseada es alta, aunque no se mueva un
centímetro.

Si emitiéramos la velocidad deseada, **el filtro `speed < 0.5` no vería jamás un
atasco**. El detector estaría ciego, y encima en silencio.

**Por eso el servidor emite velocidad MEDIDA:** guarda la posición de la muestra
anterior y calcula el desplazamiento real entre muestras. Un auto trabado reporta ~0,
porque de verdad no se movió.

> **La lección general:** la calidad del dato se define **en la fuente**. Ningún
> algoritmo aguas abajo puede arreglar un dato que ya nació mintiendo.

### 3.4 La detección: dos umbrales, no uno

Spark hace, sobre la ventana deslizante:

1. **Filtra** los detenidos: `speed < SPEED_THRESHOLD`.
2. **Agrupa** por `(ventana, sala, celda_x, celda_y)`.
3. Exige **dos** condiciones a la vez:
   - **`stationary_avatars >= MIN_STATIONARY_AVATARS`** — hay suficientes avatares
     distintos quietos en esa celda.
   - **`mean_dwell_s >= MIN_MEAN_DWELL_S`** — y además **se quedaron**.

**¿Por qué hacen falta las dos?** Acá está el corazón del detector, y es la parte que
más vale entender:

El conteo de avatares distintos dentro de una ventana es **acumulativo y monotónico**:
una vez que un auto frenó ahí, ya cuenta, aunque después arranque. Entonces, **con solo
esa condición, cualquier semáforo con tránsito normal es una zona roja permanente** —
por un semáforo pasan diez autos distintos que frenan dos segundos cada uno.

La segunda condición lo arregla. `mean_dwell_s` = muestras detenidas ÷ avatares
distintos y, como emitimos a 1 Hz (§3.2), **eso es aproximadamente "cuántos segundos se
quedó quieto cada avatar, en promedio"**.

- Semáforo: 10 autos × ~2 muestras detenidas cada uno → dwell ≈ 2 s → **no dispara**.
- Atasco real: 8 autos × ~15 muestras detenidas → dwell ≈ 15 s → **dispara**.

> Exigir permanencia es lo que separa **congestión** de **frenada normal**. Sin eso, el
> detector grita "zona roja" en cada esquina de la ciudad y no detecta nada.

Hay un test que fija exactamente esta regresión: 8 avatares frenando ~2 s en un semáforo
**no deben** generar zona roja (`tests/test_detection_logic.py`).

### 3.5 La vuelta: de `red-points` a la ruta recalculada

Spark emite el punto rojo a `red-points`. Del otro lado:

1. El **`RedPointStore`** del servidor consume `red-points`.
2. Mapea el centro de la celda → índice de zona del overlay (grilla 16×13).
3. La marca como activa **con un TTL de 15 segundos**.
4. Cada tick, esas zonas activas se aplican al grafo de calles: **penalización fuerte**
   en las aristas de la zona, se invalidan las rutas cacheadas que la cruzan y se
   **reroutean** los avatares que venían en camino.
5. Las zonas viajan al navegador en el campo `rz` del `world_snapshot` → se pintan.

**El TTL es cómo se APAGA una zona.** No existe un evento "bloqueo resuelto": mientras
la congestión siga, Spark re-emite la celda (modo `update`, §2.8) y cada re-emisión
**refresca el TTL**. Cuando la calle se despeja, Spark deja de emitir, nadie refresca el
TTL, y la zona se apaga sola en ~15 s.

Es un patrón que vale la pena tener en la cabeza: **estado vivo con vencimiento**, en
lugar de un protocolo de encendido/apagado. No hay que manejar el evento de apagado, y
es inmune a que se pierda un mensaje.

### 3.6 La grilla: por qué está anclada a media manzana

El detector parte el mapa en celdas de **30×30 unidades** ancladas en **(-240, -195)**.
La misma grilla, exactamente, que el overlay del metaverso (16×13 = 208 zonas).

El ancla no es arbitraria: está corrida **media manzana**. Si la grilla arrancara en un
eje de calle, **los dos carriles de una misma avenida caerían en celdas distintas** y
la congestión se partiría al medio entre dos celdas — con lo cual ninguna llegaría al
umbral, y la zona roja se pintaría **al lado** del atasco.

> Regla: **la grilla del detector y el overlay del metaverso tienen que ser la misma
> grilla.** Si tocás una, tocás la otra. Están enlazadas por variables de entorno
> (`CELL_SIZE_X/Y`, `GRID_ORIGIN_X/Y`), no por código.

---

## 4. Tres topics físicos (y por qué)

| Topic físico | Quién produce | Quién consume | Qué lleva |
|---|---|---|---|
| `avatar-positions` | servidor | **Spark** | Una posición por avatar por segundo. **Contrato con el Big Data.** |
| `red-points` | **Spark** | servidor | Las celdas detectadas como zona roja. **Contrato con el Big Data.** |
| `sim-events` | servidor | servidor (dashboard) | **11 topics lógicos internos** consolidados en uno. |

Los eventos internos de la simulación (`agent.spawn`, `incident.start`,
`analytics.snapshot`, `route.decision`, …) **no son parte del contrato con el Big
Data**: alimentan el dashboard del admin.

**¿Por qué consolidados?** Event Hubs Standard **limita el namespace a 10 event hubs**.
11 topics internos + 2 del contrato = 13. No entran. Así que los internos viajan todos
por `sim-events` y **cada mensaje lleva su topic lógico adentro**, en el campo `topic`.
El consumidor lo desenvuelve y lo re-despacha. Total: **3 topics físicos**.

Es una restricción de la nube filtrándose en el diseño. Está bien que lo sepas: es
exactamente el tipo de cosa que aparece cuando bajás de la pizarra al presupuesto real.

---

## 5. Parámetros: defaults del código ≠ lo que corre

**Esta es la confusión número uno del proyecto. Leela dos veces.**

El detector tiene defaults **en el código**, pero **nunca corre con ellos**: los perfiles
de entorno (`env/env.dev.example`, `env/env.prod.example`) los sobreescriben con la
**calibración validada**.

| Parámetro | Default en código | **Perfil calibrado (lo que corre)** |
|---|---|---|
| `CELL_SIZE_X` / `CELL_SIZE_Y` | 100 / 100 | **30 / 30** |
| `GRID_ORIGIN_X` / `GRID_ORIGIN_Y` | 0 / 0 | **-240 / -195** |
| `WINDOW_DURATION` | 30 seconds | **10 seconds** |
| `WINDOW_SLIDE` | 10 seconds | **5 seconds** |
| `MIN_STATIONARY_AVATARS` | 5 | **7** |
| `MIN_MEAN_DWELL_S` | 12 | **5** |
| `SPEED_THRESHOLD` | 0.5 | 0.5 *(no se sobreescribe)* |

Si leés el código y sacás conclusiones de los defaults, **estás mirando parámetros que
nadie usa**. La verdad está en `env/`.

Los valores calibrados salen de medir la física real de la cola en el metaverso: una
cola típica ocupa 6–9 avatares por celda (de ahí el umbral de 7) y se sostiene varios
segundos (de ahí el dwell de 5). No son números elegidos a dedo.

> **Fuente única de verdad:** `env/env.prod.example`. El script de despliegue **lee ese
> archivo** y de ahí calibra el job de Databricks. Así el detector de Azure no puede
> quedar desalineado del overlay del metaverso.

---

## 6. Qué pasa cuando algo se cae

| Escenario | Qué hace el sistema |
|---|---|
| **Kafka no está** | El servidor arranca igual, en **modo local**: los eventos internos van por un bus en memoria y el dashboard sigue vivo. **Pero no hay zonas rojas** (no hay Spark). Lo dice en el log, fuerte. |
| **Spark no corre** | Todo funciona menos la detección. **Cero zonas rojas.** Es el comportamiento esperado, no un bug. |
| **Event Hubs mal configurado** | Falla **ruidosamente**. Nunca cae en silencio a `localhost` (un fallback silencioso en prod es peor que un crash: creés que estás midiendo Azure y estás midiendo tu laptop). |
| **El consumidor de red-points se cae** | Se marca en `error` y **se niega** a escuchar el bus local — ese bus estaría muerto y las zonas serían mentira. Fallar fuerte > mentir. |

El hilo conductor: **preferimos fallar ruidosamente antes que degradar en silencio.**
Una zona roja que no aparece es un dato falso sobre H1.

---

## 7. Dev y prod son el mismo código

| | Local (distrobox) | Azure |
|---|---|---|
| **Broker** | Kafka nativo `localhost:9092` | Event Hubs `<ns>.servicebus.windows.net:9093` (SASL_SSL) |
| **Spark** | `make detector` (local) | Job de Databricks (el mismo `.py`) |
| **Metaverso** | `make metaverse-server` + Vite | VM Ubuntu: nginx sirve el cliente, systemd corre el servidor |
| **Qué cambia en el código** | — | **Nada.** Solo `KAFKA_BOOTSTRAP` + `EVENTHUBS_CONNECTION_STRING`. |

Esa paridad no es cosmética: es lo que hace que lo que validamos en la laptop sea
**evidencia** sobre lo que corre en la nube. Si el código de prod fuera otro, la
validación local no probaría nada.

---

## 8. Cómo lo corrés

**Local (todo el loop, un comando):**

```bash
make dev     # Kafka + detector Spark + servidor + cliente web
```

**Azure:**

```bash
make deploy          # infra + app + job del detector (pausado)
make detector-start  # detector ON
make detector-stop   # detector OFF — lo único que cobra por hora
```

**Verificación de que la cadena está viva:** creás una sala, metés flotas grandes,
generás un atasco. Al formarse la cola (≥7 detenidos ~5 s en una celda), la zona se
pinta de roja y las rutas la esquivan. Al despejarse, se apaga en ~15-20 s.

Si no aparecen zonas rojas, mirá **en este orden**: ¿corre el detector? ¿el servidor
está en modo `kafka` y no `local`? ¿el heartbeat del servidor muestra `redpoints:`
creciendo? Un `make consume TOPIC=red-points` te dice en dos segundos si Spark está
emitiendo o no.

---

## 9. Lo que el sistema NO hace (honestidad intelectual)

- **El metaverso no detecta.** Su detección interna existe en el código pero corre en
  modo `metricsOnly`: calcula un índice de congestión para el dashboard y **nada más**.
  No pinta zonas, no penaliza rutas, no rerutea. Está desconectada a propósito.
- **No hay evento de "bloqueo resuelto".** Las zonas se apagan por TTL (§3.5).
- **`approx_count_distinct` es aproximado** (HyperLogLog, ~2% de error). Es una decisión
  consciente: precisión vs latencia. Para una decisión de umbral, alcanza — y es
  material de tesis, no un descuido.
- **El archivado histórico a ADLS es opcional** y está **apagado** por defecto
  (`ARCHIVE_PATH` vacío).

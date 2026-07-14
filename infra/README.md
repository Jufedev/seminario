# Infraestructura Azure — Terraform

Provisiona la arquitectura de analítica en tiempo real (ver `docs/arquitectura.drawio`).

**Una sola etapa de Terraform.** El detector corre como **contenedor** en Azure Container
Apps, no en Databricks. El porqué está en [El detector: por qué un contenedor y no un
cluster](#el-detector-por-qué-un-contenedor-y-no-un-cluster); el registro histórico completo,
en [`../docs/memory/11-container-detector.md`](../docs/memory/11-container-detector.md). La
v1 con Databricks queda preservada en la rama `v1-databricks`.

## Cómo están nombradas las cosas

**Un resource group por ROL del pipeline**, no por categoría de recurso de Azure: quien abre
el portal tiene que poder decir qué hay adentro de un grupo **sin abrirlo**.

| Resource group | Qué hay adentro | Costo |
|---|---|---|
| `rg-metaverso-network` | `vnet-metaverso-app`, `snet-metaverso-app-public`, `nsg-metaverso-app` — la red de la VM (abre 22, 80 y 8080) | Gratis |
| `rg-metaverso-app` | `vm-metaverso-app` (E2s_v3, Ubuntu 22.04) + `pip-` / `nic-` / disco. Frontend nginx :80 y backend bun :8080, auto-provisionados por cloud-init | **~$0.126/h prendida** |
| `rg-metaverso-streaming` | `evhns-metaverso-*` (Event Hubs Standard, 1 TU): hubs `avatar-positions`, `red-points` y `sim-events`, retención 7 días | **~$0.015/h** (~$11/mes) |
| `rg-metaverso-analytics` | El runtime del detector: `crmetaverso*` (registro), `cae-metaverso` (entorno de Container Apps), `ca-metaverso-detector` (el detector), `log-metaverso-detector` y la identidad que baja la imagen | Registro ~$5/mes + el detector solo mientras corre |
| `rg-metaverso-datalake` | `stmetaverso*` (ADLS Gen2, LRS) + filesystem `avatar-events` — **checkpoint de Spark** (siempre) y archivo histórico (opt-in) | Centavos |
| `rg-metaverso-governance` | `budget-metaverso`, `ag-metaverso-budget`, `aa-metaverso-killswitch` — control de gasto. No sirve tráfico | Gratis |

**Seis grupos, y seis es lo que muestra el portal.** La v1 tenía un SÉPTIMO,
`rg-metaverso-databricks-managed`, que **creaba Databricks solo**, Terraform no declaraba y
`terraform destroy` **no borraba**: había que purgarlo a mano o bloqueaba el deploy siguiente.
Ya no existe.

**Los nombres cortos van acompañados de un tag `proposito`** (en español, en cada recurso). Es
la salida al problema de que Azure limita los nombres: un storage account no puede pasar de 24
caracteres ni llevar guiones (y un registro de contenedores tampoco), así que
`stmetaverso<sufijo>` es todo lo descriptivo que la plataforma permite. El significado vive en
el tag, que el portal muestra como columna:

```bash
az resource list --query "[].{nombre:name, proposito:tags.proposito}" -o table
```

**Nota**: Event Hubs debe ser tier **Standard** — Basic no soporta el protocolo Kafka.

## El detector: por qué un contenedor y no un cluster

El 2026-07-13 el job de Databricks dejó de arrancar:

```
CLOUD_PROVIDER_RESOURCE_STOCKOUT: The requested VM size 'Standard_D4s_v3' is
currently not available in location 'eastus2'
```

**No era cuota** (la familia DSv3 marcaba 0 de 4 vCPUs usados): Azure sencillamente no tenía
capacidad de esa máquina en la región. Y **no había SKU alternativo**: todo otro SKU de 4 vCPU
está restringido por `Location` para una suscripción de estudiante — o sea, genuinamente no
disponible (ver [`Zone` vs `Location`](#zone-vs-location-la-distinción-que-lo-decide-todo)).
Tampoco servía *spot*: el spot corre sobre capacidad **sobrante**, y un stockout significa
justamente que no hay.

Buscando un plan B apareció el hallazgo de verdad. El job de la v1 corría con:

```hcl
num_workers = 0
spark_conf  = { "spark.master" = "local[*, 4]" }
```

**Cero workers, modo local.** El detector siempre fue **una sola JVM**. Nunca distribuyó una
tarea. Databricks era un envoltorio caro y limitado por capacidad alrededor de **un proceso
Python**. El stockout fue el síntoma que nos hizo mirar; el hallazgo es que el cluster nunca
hizo falta.

Hoy el detector corre en un contenedor con el **mismo `pipeline/red_point_detector.py`**,
copiado byte a byte. Sigue siendo **Apache Spark Structured Streaming** — lo que se fue es el
intermediario, no la tecnología (la tesis pide Spark, no Databricks).

| | Databricks (v1) | Container Apps (v2) |
|---|---|---|
| Interruptor de la demo | `detector_running` → pausa el job | `min_replicas` 0 / 1 |
| Tiempo hasta correr | ~5 min (arranca el job-cluster) | **segundos** |
| Costo corriendo | ~$0.60/h | ~$0.10/h |
| Costo apagado | **NAT gateway ~$0.045/h** mientras el *workspace* existiera | nada |
| Restos tras `destroy` | `rg-metaverso-databricks-managed` | ninguno |
| Etapas de Terraform | 2 | **1** |

Container Apps Consumption además tiene una **cuota mensual gratis** (180k vCPU-s + 360k
GiB-s) que a 2 vCPU / 4 GiB cubre **~25 h de detector**: una demo normalmente no paga cómputo
del detector.

Dimensionado: **2 vCPU / 4 GiB** (Consumption exige 2 GiB por vCPU), `max_replicas = 1` y
`revision_mode = "Single"` — la consulta tiene estado y es de un solo nodo: una segunda réplica
sería un segundo detector emitiendo los mismos puntos rojos.

### La imagen se construye ACÁ, con el podman del host

Hasta el 2026-07-13 la imagen se construía con `az acr build`, o sea **dentro de Azure**, y el
motivo declarado era: *"en esta caja no hay Docker ni Podman"*.

**Era falso, y vale la pena entender por qué.** Es cierto que dentro de la distrobox no hay
podman — pero **esta distrobox la corre el podman del host**. El motor de build siempre estuvo
ahí, a un salto de distancia: la caja simplemente no lo veía. `distrobox-host-exec` lo alcanza.

```
distrobox (Ubuntu 24.04)  ──distrobox-host-exec──►  podman del host (Fedora)
  terraform, az, make                                  build + push
```

**Podman va en el HOST, no adentro de la caja.** Podman-dentro-de-podman rootless no tiene
overlay-sobre-overlay, así que cae al driver de almacenamiento `vfs`, que **copia el filesystem
entero por capa**: para una imagen de Spark de ~1 GB eso es lento y voraz. El proyecto ya
descartó Docker-dentro-de-distrobox por frágil; hacerlo con podman sería el mismo error con otro
binario.

**Lo que ganamos** — y es lo que justifica el cambio, no el gusto:

- La imagen se puede **correr y probar antes de que toque Azure**: `make detector-image` la
  construye sin push, sin registro y sin sesión de Azure.
- Se pudo **verificar la afirmación central del Dockerfile**, que hasta ahora era un acto de fe:
  corriendo la imagen con `--network none`, Ivy resuelve el conector de Kafka **desde la caché
  horneada** y el detector arranca igual. Con el build adentro de Azure eso no era comprobable.
- El build deja de depender de un agente de build del lado de Azure.

**Lo que cuesta, dicho sin maquillaje:** `az acr build` subía un contexto de ~20 KB y hacía el
trabajo pesado en la red de Azure. Ahora el primer push manda **~450 MB comprimidos** desde esta
máquina (la imagen pesa 951 MB). Los push siguientes solo mandan las capas que al registro le
faltan.

El registro **no tiene admin user**, así que el push se autentica con un **token ARM de vida
corta** (`az acr login --expose-token`), que viaja por **stdin** y nunca aparece en `ps`. Por eso
`az` sigue siendo un requisito duro del deploy.

La construcción es un **nodo de Terraform** (`terraform_data.detector_image`), no un paso del
script, para que el orden sea una **dependencia real**:

```
azurerm_container_registry -> terraform_data.detector_image -> azurerm_container_app
```

La alternativa (un `apply` con `-target` del registro desde el script, después el build, después
el apply completo) se descartó: dejaría un `terraform apply` pelado —o un `make infra-apply`—
**roto para siempre**, porque intentaría crear la Container App sin imagen detrás.

**El tag de la imagen es el HASH DEL CONTENIDO** (Dockerfile + `red_point_detector.py` +
`entrypoint.sh`). De ahí salen dos propiedades, las dos buscadas:

1. Si editás el detector, cambia el tag → Container Apps despliega una **revisión nueva**. Un
   `:latest` mutable habría dejado corriendo el código viejo.
2. Si no cambió nada, mismo tag → **no se reconstruye ni se re-empuja** y no hay revisión nueva.
   Re-aplicar es gratis. Esa propiedad vale más ahora que el push sale de tu conexión: un
   detector sin cambios no manda un byte.

El registro **no tiene admin user**: la Container App baja la imagen con una **identidad
administrada** (user-assigned, no system-assigned — una system-assigned recién existe *después*
de crear la app, así que su permiso `AcrPull` llegaría tarde y el primer apply fallaría con un
error de pull).

### El conector de Kafka viaja resuelto en la imagen

`red_point_detector.py` declara `spark.jars.packages =
org.apache.spark:spark-sql-kafka-0-10_2.12:3.5.1`. Eso es una config **de submit**: Ivy resuelve
la coordenada contra Maven Central **cada vez que arranca la JVM**.

En Databricks era gratis (el conector venía en el runtime). En un contenedor efímero significaría
una dependencia **en tiempo de ejecución** con Maven Central, 30-60 s de arranque, y un detector
que se muere si Maven tiene un mal minuto.

Por eso la resolución pasa al **build**: los JARs quedan en `/opt/ivy` dentro de la imagen y en
runtime Ivy los encuentra ya cacheados y resuelve **offline**. Lo mismo con `hadoop-azure:3.3.4`,
que es lo que hace usable `abfss://` (PySpark trae las librerías *cliente* de Hadoop 3.3.4 pero
**no** el filesystem de Azure).

### Dónde vive el estado de Spark

| Qué | Dónde | ¿Opcional? |
|---|---|---|
| **Checkpoint** | `abfss://avatar-events@<cuenta>.dfs.core.windows.net/checkpoints/red-point-detector` | **No.** Siempre |
| **Archivo histórico** | `abfss://avatar-events@<cuenta>.dfs.core.windows.net/positions` | Sí (`ENABLE_ARCHIVE=true`) |

El checkpoint **persiste a propósito**. Un contenedor es efímero: si Azure lo reinicia solo (OOM,
expulsión, mantenimiento), un checkpoint local se iría con él y Spark retomaría en `latest`, o
sea **abriría un agujero de detección en silencio**. Con el checkpoint en ADLS, la réplica nueva
retoma desde los offsets confirmados.

Y acá es donde `is_hns_enabled = true` deja de ser un checkbox: un **namespace jerárquico** da
**rename atómico**, la primitiva sobre la que está construido el protocolo de commit del
checkpoint de Spark. Un blob plano no puede darla.

> ⚠️ **Consecuencia — y es la semántica de la v1 volviendo:** el checkpoint guarda los offsets de
> Event Hubs y el estado de las ventanas. Cambiar `WINDOW_DURATION`, `WINDOW_SLIDE` o la
> agregación en prod pide una **migración** del checkpoint, no un borrado. `make clean` es un
> movimiento de **dev**. `scripts/deploy-azure.sh` compara la ventana nueva contra la última
> desplegada y **avisa antes de aplicar**, porque regenera la calibración desde
> `env/env.prod.example` en cada deploy y el cambio se colaría sin que nadie lo note.

**Escape hatch:** `checkpoint_dir_override`. La escritura ABFS con shared key es lo único del
camino de **arranque** del detector que nunca se ejecutó contra una cuenta HNS real, y si falla
el detector **no arranca**. Poner un path local del contenedor
(`/tmp/checkpoints/red-point-detector`) devuelve un detector que arranca seguro a cambio de
perder el estado en cada reinicio. Una decisión, en un flag, tomada con calma — y no editando
Terraform con el jurado esperando.

### Retención de Event Hubs y `failOnDataLoss`

Los tres hubs tienen **retención de 7 días** (el máximo del tier Standard, **sin costo extra**)
y el detector lee con **`failOnDataLoss = false`**.

Las dos cosas atacan la misma mina: el checkpoint sobrevive entre demos, pero Event Hubs **borra**
los mensajes al vencer la retención. Con el default de 1 día, una demo tres días después de la
anterior encontraría offsets confirmados apuntando a mensajes que ya no existen — y Spark, con su
default `failOnDataLoss = true`, **se negaría a arrancar**, justo cuando hace falta. La retención
larga hace que casi nunca pase; el flag hace que, si pasa, el detector salte al offset más viejo
que exista y siga.

### No hay consumer groups declarados (a propósito)

La v1 declaraba dos (`spark-detector` y `metaverse-backend`) y **nadie los usaba**:

- La fuente Kafka de Spark **no toma un group id nuestro**: genera el suyo
  (`spark-kafka-source-<uuid>`) y lleva los offsets en **su checkpoint**, no en el broker. Ese es
  el diseño, y es lo que hace que las semánticas de reinicio de arriba funcionen.
- `RedPointStore` usa un group id **efímero por proceso**, para que un reinicio del servidor no
  pueda resucitar zonas rojas viejas desde un offset confirmado. Las zonas rojas son estado
  **vivo**, con TTL.
- El consumidor de analytics usa `ecci-analytics`.

Eran decoración, y el diagrama de arquitectura repetía la ficción como si fuera un hecho ("Spark
consume (cg: spark-detector)"). Se borraron.

## Los límites de Azure for Students (leer antes de tocar SKUs o región)

Esta sección sigue siendo válida — y ahora es, además, **la evidencia de por qué el detector se
fue de las VMs**.

Una suscripción de estudiante impone **tres restricciones distintas a la vez**. Las tres fallan
de forma diferente, y confundirlas cuesta horas:

| Restricción | Qué pasa si la violás |
|---|---|
| **Política de regiones permitidas** | `403 RequestDisallowedByAzure`. No es cuota: Azure directamente prohíbe la región. |
| **6 vCPUs totales** por región | Error de cuota al crear la VM. |
| **4 vCPUs por familia** de VM | Error de cuota — y aparece en el recurso equivocado. |

**Las regiones permitidas** son solo cinco (verificalas, pueden cambiar):

```bash
az policy assignment list --query "[].parameters" -o json
# -> southcentralus, brazilsouth, eastus2, mexicocentral, canadacentral
```

En la v1 el reparto de vCPUs **entraba exacto y sin margen**:

| Recurso | SKU | Familia | vCPUs |
|---|---|---|---|
| VM de la app | `Standard_E2s_v3` | ESv3 (límite 4) | 2 |
| ~~Nodo de Databricks~~ | ~~`Standard_D4s_v3`~~ | ~~DSv3 (límite 4)~~ | ~~4~~ |
| | | **Total v1** | **6 / 6** |

Estaban en familias distintas **a propósito**: en la misma se habrían comido los 4 vCPUs entre
ellas y el cluster nunca habría arrancado, con un error de *cuota* que aparece en Databricks sin
nada que apunte a la VM que se comió el presupuesto.

**Hoy la VM de la app es la ÚNICA VM del despliegue: 2 de 6 vCPUs, sin contención por familia.**
El detector no tiene SKU de VM (Container Apps Consumption es serverless), así que no hay ningún
SKU del que Azure pueda quedarse sin stock.

### `Zone` vs `Location`: la distinción que lo decide todo

Al mirar si un SKU sirve, **no alcanza con ver si tiene restricciones**: hay que ver de
qué **tipo** son.

```bash
az vm list-skus -l eastus2 --resource-type virtualMachines --all \
  --query "[?name=='Standard_E2s_v3'].{tipo:restrictions[0].type, motivo:restrictions[0].reasonCode}" -o table
```

- **`type = Zone`** → **usable**. Solo está bloqueado para despliegues fijados a una zona
  de disponibilidad. La VM no fija zona (`zone_id` es un concepto de AWS), así que despliega
  sin problema.
- **`type = Location`** → **genuinamente no disponible** para tu suscripción.

> Filtrar por "SKUs sin ninguna restricción" es la trampa: esconde SKUs perfectamente
> usables. `Standard_E2s_v3` tiene las tres zonas restringidas y aun así funciona.

Esta distinción es exactamente la que dejó al detector sin salida en la v1: **todo SKU de 4 vCPU
distinto de `Standard_D4s_v3` está restringido por `Location`** en esta suscripción. Cuando Azure
se quedó sin stock de D4s_v3, no había a dónde caer. Un stockout no es una cuota: **no se
resuelve pidiendo más**.

Cuotas por familia: `az vm list-usage -l eastus2 -o table`.

## Requisitos

- Terraform >= 1.5 (o OpenTofu)
- Azure CLI autenticado: `az login` — **también lo usa el `apply`**, para sacar el token con el
  que se empuja la imagen del detector al registro
- **Podman (o Docker)**: el `apply` construye la imagen del detector. Se busca primero dentro de
  la caja y después **en el host**, vía `distrobox-host-exec` — que es donde normalmente está,
  porque es el mismo motor que corre esta distrobox. El preflight de `make deploy` lo verifica
  antes de gastar un centavo.
- Suscripción activa (Azure for Students)
- **El repositorio debe ser público**: cloud-init lo clona por HTTPS sin
  credenciales para desplegar la app en la VM (o pasar `repo_url` con token).
  *(El detector NO depende de esto: su código viaja dentro de la imagen, que se construye desde
  tu working copy.)*

## Despliegue

Todo el ciclo de vida está automatizado en `scripts/deploy-azure.sh` (desde la
raíz del repo). El script no reemplaza a Terraform: lo orquesta, y todo lo que
crea es declarativo.

```bash
make detector-image    # construye la imagen del detector LOCAL: sin push, sin Azure
make deploy            # infra + app en la VM + contenedor del detector (creado APAGADO)
make detector-start    # detector ON  — 1 réplica: levanta en segundos
make deploy-status     # IP, web, VM, réplicas del detector y salud de sus revisiones
make detector-stop     # detector OFF — 0 réplicas: el contenedor deja de cobrar
make deploy-down       # terraform destroy de todo (lo único que deja el gasto en $0)
```

`make deploy` hace, en orden:

1. **Preflight**: `az login` activo; **hay podman o docker** (en la caja o en el host);
   el repo es **público** y tu HEAD está **pusheado** (cloud-init clona GitHub
   anónimamente — si el repo es privado la VM arranca vacía, y si no pusheaste
   despliega código viejo, en ambos casos con el `apply` en verde).
2. **Guard del kill-switch**: aborta si el kill-switch disparó (ver abajo).
3. Genera `infra/terraform.tfvars` (email del presupuesto, llave SSH — la crea si
   no existe, `repo_url` derivado de tu `origin`). Se escribe **una sola vez**.
4. Genera `infra/detector.auto.tfvars` con la calibración leída de
   `env/env.prod.example`, la **fuente única de verdad** compartida con el overlay del
   metaverso. Si cambió la ventana, **avisa** (el checkpoint viejo es incompatible).
5. `terraform apply` en `infra/` — **una sola etapa**. El apply también **construye la
   imagen** del detector con el podman del host y la **empuja** al registro (~4 min de build
   + ~450 MB de push la primera vez; después solo las capas que cambian) y crea la Container
   App **apagada** (`min_replicas = 0`).
6. Escribe `.env.azure` (perfil listo para correr el detector/metaverso local
   contra Azure: `cp .env.azure .env`).
7. Espera a que cloud-init termine y la web responda 200 (~5 min).

Variables opcionales: `BUDGET_EMAIL`, `SSH_PUBLIC_KEY_FILE`, `ENABLE_ARCHIVE=true`
(archiva el histórico de posiciones en ADLS — ojo: si ese stream falla, se cae el detector
con él, porque comparte `awaitAnyTermination()` con el de zonas rojas).

### Una sola etapa de Terraform

La v1 tenía dos módulos raíz (`infra/` + `infra/databricks/`) por **un único motivo**: el
provider `databricks` necesitaba la URL del workspace, y **un provider no se puede configurar
con un valor que se crea en el mismo `apply`**. Sin Databricks, el motivo desapareció.
`infra/databricks/` está borrado.

### El detector: encendido y apagado

`min_replicas` es el interruptor: **0 réplicas = no hay contenedor = $0/h del detector**; 1 =
corriendo. El estado deseado vive en `infra/terraform.tfvars` (`detector_running`), no en un
`-var` suelto, para que un redespliegue no apague en silencio un detector que estaba corriendo.

> ⚠️ **`make detector-stop` NO deja el gasto en $0.** Apaga el contenedor, no el despliegue.
> Sigue cobrando:
>
> | Recurso | Costo |
> |---|---|
> | VM de la app (prendida) | ~$0.126/h ← lo más caro que queda |
> | Event Hubs (Standard, 1 TU) | ~$0.015/h |
> | Registro (ACR Basic) | ~$5/mes fijo |
> | Log Analytics | por ingesta (poco a este volumen; 5 GiB/mes son gratis) |
>
> Total **≈ $0.15/hora ≈ $3.4/día**. `./scripts/deploy-azure.sh vm-stop` desasigna la VM;
> **solo `make deploy-down` deja el gasto en cero.**

### Verificación end-to-end

1. Navegador → `http://<vm_public_ip>` → crear sala como admin.
2. Usuarios se unen con el código, configuran flotas grandes y las invocan.
3. Al formarse una cola (≥7 detenidos ~5 s en una celda), la zona se pinta de
   roja y las rutas la esquivan; al drenarse, se apaga en ~15-20 s.
4. Si no aparecen zonas: `make deploy-status` (¿el detector está en 1 réplica? ¿alguna
   revisión en crash-loop?), los logs del contenedor, y el heartbeat del backend
   (`journalctl -u metaverse-server | grep heartbeat` — `redpoints:` debe crecer).

Los logs del detector son la única ventana a la consulta de streaming:

```bash
az containerapp logs show -n ca-metaverso-detector -g rg-metaverso-analytics --follow --tail 100
```

Buscá el banner `RED-POINT DETECTOR — CONTAINER START`. **Si aparece más de una vez, el
contenedor se reinició** — que es la diferencia entre "Spark está calentando" y "el detector
está en crash-loop hace diez minutos".

Si la web no carga, diagnosticar por SSH:

```bash
ssh azureuser@<ip>
sudo cat /var/log/cloud-init-output.log   # ¿falló el clone/build?
systemctl status metaverse-server         # ¿corre el backend?
```

### Después de cada demo

```bash
make detector-stop                  # apaga el contenedor del detector
./scripts/deploy-azure.sh vm-stop   # desasigna la VM: es lo más caro que queda prendido
```

## Presupuesto y kill-switch

**Un budget de Azure no corta el gasto: solo avisa.** Azure no tiene un tope duro. Así
que el budget, al llegar al 100%, además de mandar el mail dispara un **action group**
→ **runbook de Automation** (`killswitch.ps1`) que apaga lo que cobra por hora.

| Umbral | Qué pasa |
|---|---|
| **$10** (`budget_alert_amount`) | Email de aviso. No se toca nada. |
| **$30** (75%) | Email. |
| **Pronóstico de superar $40** | Email — es la **única** alerta que puede llegar ANTES de gastar la plata. |
| **$40** (`budget_amount`) | Email + **kill-switch**: desasigna la VM y escala el detector a **0 réplicas**. |

El runbook **no borra nada**: desasigna la VM (una VM "detenida" sigue cobrando; una
*desasignada* no) y escala la Container App a `min_replicas = 0` — el **mismo interruptor**
que usa `make detector-stop`. Volvés con `make detector-start` y
`./scripts/deploy-azure.sh vm-start`.

> Este paso reemplaza al "pausar los jobs de Databricks" de la v1. Errarle habría sido peor
> que inútil: el kill-switch apagaría la VM y dejaría el contenedor del detector corriendo,
> que es justamente lo que cobra por hora. **Un guardián de costos que no corta el costo no
> es un guardián.**

**Cómo llega el runbook a la Container App:** por la **API REST de ARM**, no con
`Update-AzContainerApp`. Un Automation Account trae `Az.Accounts`/`Az.Compute` pero **no**
`Az.App`, y la llamada REST solo necesita un token. El `PATCH` es un *JSON Merge Patch* que
manda **únicamente** `properties.template.scale.minReplicas`: no puede tocar la imagen, los
secretos ni el entorno de la app que está tratando de salvar.

### Permisos: un rol custom de CUATRO acciones, no `Contributor`

`Contributor` sobre el resource group era la respuesta fácil y la equivocada.
`rg-metaverso-analytics` ahora tiene el registro, el entorno de Container Apps y el detector,
así que `Contributor` ahí le daría a una identidad **alcanzable por webhook** (el action group
la llama por URL) permiso para borrar el registro, reescribir la imagen o leer los secretos.

Lo que el runbook realmente hace es desasignar una VM y setear un entero. Eso es todo lo que
recibe:

```
Microsoft.Compute/virtualMachines/read
Microsoft.Compute/virtualMachines/deallocate/action
Microsoft.App/containerApps/read
Microsoft.App/containerApps/write
```

(`containerApps/write` es el piso, no una concesión: ARM no tiene una acción "solo escalar", y
un `PATCH` es una escritura. Lo que sí compra el scoping es que el radio de explosión termina
en la Container App: el registro, el entorno y Log Analytics quedan fuera de alcance.)

### El deploy se NIEGA a revertir un kill-switch que disparó

El runbook escala a 0 réplicas **por afuera de Terraform**, pero el estado deseado sigue
diciendo `detector_running = true` en el tfvars. Entonces el próximo `terraform apply` —un
`make deploy`, un `make infra-apply`, hasta uno "inocente" para cambiar otra cosa— convergería
la realidad al estado declarado y **volvería a prender exactamente el gasto que la red de
seguridad acababa de cortar**, sin decir una palabra.

Por eso `scripts/deploy-azure.sh` compara el estado deseado contra las réplicas **reales** de
Azure y **aborta** si detecta la discrepancia. Y **no lo arregla solo, a propósito**: que el
kill-switch haya disparado significa que se tocó el techo del presupuesto. Eso lo mira una
persona, revisa cuánto gastó, y recién ahí decide encender de nuevo con `make detector-start`
— el único comando que salta el guard, porque es el acto explícito de revertirlo.

> ⚠️ **Esto es una red de seguridad, no un freno de mano.** Los datos de costo de Azure
> **llegan con horas de retraso**: cuando el budget "vea" los $40, el gasto real puede
> ser mayor. El freno de mano sigue siendo `make detector-stop` al terminar la demo.

### Si el `apply` falla en el kill-switch: `enable_killswitch = false`

Una suscripción de estudiante permite **una sola Automation Account por región**, y una
cuenta **borrada retiene el cupo durante horas** — de forma **invisible**: `az automation
account list` no devuelve nada mientras Azure sigue rechazando la creación con

```
400 "Only one account is allowed for your subscription per Region.
     If Deleted recently, please restore the same account"
```

Como la única región legal es `eastus2` (ver abajo), **no hay a dónde escaparse**: un
`deploy-down` seguido de un `deploy` el mismo día no puede crear el kill-switch.

Eso **no debe bloquear el despliegue entero** ni —sobre todo— llevarse puestas las alertas
del budget. Por eso el kill-switch es opcional:

```hcl
# infra/terraform.tfvars
enable_killswitch = false
```

Con esto en `false`, **el budget sigue avisando por email en todos los umbrales**; lo único
que se pierde es el apagado automático. Cuando Azure libere el cupo, poné `true` y
`make deploy` otra vez (agrega los recursos del kill-switch, no toca nada más).

> El diseño anterior tenía el bug al revés: la notificación del 100% referenciaba el action
> group, así que si la Automation Account fallaba **se caía el budget completo** — incluidos
> los tres avisos por email que no la necesitan. Un guardián de costos que puede bloquear su
> propio despliegue no es un guardián.

### La región del kill-switch: dos listas, una sola intersección

La Automation Account es el único recurso al que **dos listas de regiones distintas** le
aplican a la vez, y solo su intersección es válida:

| Restricción | Regiones que permite |
|---|---|
| Política de la suscripción (la misma que todo el resto) | `southcentralus`, `brazilsouth`, **`eastus2`**, `mexicocentral`, `canadacentral` |
| Azure Automation en suscripción Student/Free | `eastus`, **`eastus2`**, `westus`, `northeurope`, `southeastasia`, `japanwest` |

**La intersección es `eastus2` y nada más.** Cualquier otra región falla con un 400:
`"Free Trial and Student subscriptions cannot create accounts in this location"`.

Esto importa porque una suscripción de estudiante permite **una sola Automation Account por
región**, y borrarla **no libera el cupo enseguida** (`"If Deleted recently, please restore
the same account"`). La tentación es mover la cuenta a otra región para no gastar el cupo de
la principal — **no se puede**: no hay otra región legal.

Consecuencia práctica: un `deploy-down` seguido de un `deploy` inmediato puede fallar acá,
en el último recurso, con todo lo demás ya creado. Si pasa, esperá a que Azure libere el
cupo (horas) o desplegá con `enable_killswitch = false` y volvé a activarlo después.

### Probalo ANTES de necesitarlo

Un kill-switch que nunca se ejecutó es una suposición, no una protección. Después del
primer `make deploy`, disparalo a mano una vez y mirá que la VM quede `deallocated` y el
detector en 0 réplicas:

```bash
az automation runbook start \
  --resource-group rg-metaverso-governance \
  --automation-account-name aa-metaverso-killswitch \
  --name Stop-BillableCompute

az vm show -d -g rg-metaverso-app -n vm-metaverso-app --query powerState -o tsv
# -> "VM deallocated"

az resource show --ids "$(terraform -chdir=infra output -raw detector_app_id)" \
  --api-version 2024-03-01 --query 'properties.template.scale.minReplicas' -o tsv
# -> 0
```

Si el runbook falla por módulos de PowerShell faltantes (`Az.Accounts` / `Az.Compute`),
importalos desde la galería en el Automation Account — es la única dependencia externa
que tiene.

Ajustar los montos: `budget_alert_amount` (aviso) y `budget_amount` (corte) en
`infra/terraform.tfvars`.

## Prueba local con Floci (opcional, antes de gastar créditos)

El provider `azurerm` descubre los endpoints por HTTPS, así que Floci debe
correr con TLS habilitado:

1. Arrancar floci-az con `FLOCI_AZ_TLS_ENABLED=true`.
2. Descargar el certificado autofirmado: `http://localhost:4577/_floci/tls-cert`
   e instalarlo en el truststore del sistema.
3. Descomentar `metadata_host = "localhost:4577"` en `providers.tf`.
4. `terraform init && terraform apply` contra el emulador.

Consultar la guía de Terraform en la documentación de Floci para el detalle
de autenticación en modo dev. Verificar qué recursos soporta el emulador:
Event Hubs y Storage están listados; **Container Apps, ACR, VM y Consumption Budget
probablemente NO** — si el `apply` falla en esos recursos contra Floci, es
esperado (se validan solo contra Azure real con `terraform plan`). El push de la imagen del
detector tampoco tiene sentido contra el emulador — pero el **build** sí corre sin Azure de por
medio: `make detector-image`.

## Destruir todo

```bash
make deploy-down
```

Sin Databricks **no queda nada huérfano que limpiar**: el registro y sus imágenes se van con
el resource group, y el `rg-metaverso-databricks-managed` que `terraform destroy` nunca borraba
—y que bloqueaba el deploy siguiente— ya no existe.

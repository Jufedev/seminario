# Infraestructura Azure — Terraform

Provisiona la arquitectura de analítica en tiempo real (ver `docs/arquitectura.drawio`).

## Cómo están nombradas las cosas

**Un resource group por ROL del pipeline**, no por categoría de recurso de Azure: quien abre
el portal tiene que poder decir qué hay adentro de un grupo **sin abrirlo**.

| Resource group | Qué hay adentro | Costo |
|---|---|---|
| `rg-metaverso-network` | `vnet-metaverso-app`, `snet-metaverso-app-public`, `nsg-metaverso-app` — la red de la VM (abre 22, 80 y 8080) | Gratis |
| `rg-metaverso-app` | `vm-metaverso-app` (E2s_v3, Ubuntu 22.04) + `pip-` / `nic-` / disco. Frontend nginx :80 y backend bun :8080, auto-provisionados por cloud-init | ~$30/mes prendida |
| `rg-metaverso-streaming` | `evhns-metaverso-*` (Event Hubs Standard, 1 TU): hubs `avatar-positions`, `red-points` y `sim-events` | **~$11/mes fijo** |
| `rg-metaverso-analytics` | `dbw-metaverso-detector` (Databricks premium) y el job `red-point-detector` | Ver abajo |
| `rg-metaverso-datalake` | `stmetaverso*` (ADLS Gen2, LRS) + filesystem `avatar-events` — archivo histórico | Centavos |
| `rg-metaverso-governance` | `budget-metaverso`, `ag-metaverso-budget`, `aa-metaverso-killswitch` — control de gasto. No sirve tráfico | Gratis |
| `rg-metaverso-databricks-managed` | ⚠️ **Lo crea Databricks, no Terraform.** Ver más abajo | Ver abajo |

**Los nombres cortos van acompañados de un tag `proposito`** (en español, en cada recurso). Es
la salida al problema de que Azure limita los nombres: un storage account no puede pasar de 24
caracteres ni llevar guiones, así que `stmetaverso<sufijo>` es todo lo descriptivo que la
plataforma permite. El significado vive en el tag, que el portal muestra como columna:

```bash
az resource list --query "[].{nombre:name, proposito:tags.proposito}" -o table
```

**Nota**: Event Hubs debe ser tier **Standard** — Basic no soporta el protocolo Kafka. Y
Databricks debe ser **premium**: Azure retiró el tier Standard.

## El resource group que crea Databricks (y que `destroy` no borra)

Al crear el workspace, **Databricks crea un resource group propio**
(`rg-metaverso-databricks-managed`). Terraform no lo declara, no lo conoce y
**`terraform destroy` no lo borra**: sale en verde y lo deja atrás.

Adentro hay cinco cosas que explican casi todo lo raro que se ve en el portal:

| Recurso | Qué es | Costo |
|---|---|---|
| `nat-gateway` + `nat-gw-public-ip` | La **única** salida a internet de los workers del cluster | **~$0.045/h mientras el workspace exista**, haya cluster o no |
| `workers-vnet` + `workers-sg` | La red de los nodos del cluster | Gratis |
| `dbstorage*` | El **DBFS root**: storage interno obligatorio del workspace. Por esto ves **dos** storage accounts | Centavos |
| `unity-catalog-access-connector`, `dbmanagedidentity` | Identidad del workspace | Gratis |

### ¿Por qué hay un NAT gateway?

Databricks parte su arquitectura en dos: el **control plane** (la UI, el scheduler) vive en la
suscripción de Databricks; los **workers** viven en la tuya. Con *secure cluster connectivity*
—el default— los workers **no tienen IP pública** y no aceptan nada entrante: son **ellos** los
que abren un túnel **saliente** al control plane, y las órdenes bajan por ese túnel.

Pero una VM sin IP pública **no tiene forma de salir a internet**. Necesita que alguien le haga
SNAT. Ese alguien es el NAT gateway, y sin esa salida el cluster ni siquiera se registra: el job
nunca arranca.

Se puede evitar apagando la secure cluster connectivity (`no_public_ip = false`), pero es un
downgrade de seguridad y Azure está retirando ese modo. **No lo hagas.**

### La consecuencia operativa

El NAT gateway se borra **junto con el workspace**, así que solo cobra mientras el despliegue
está en pie. Lo que **sobrevive** al destroy es el DBFS y el access connector: cuestan centavos,
pero como el nombre del RG deriva del nuestro, **un resto bloquea la creación del próximo
workspace**.

Por eso `scripts/deploy-azure.sh` lo borra en `down` y verifica que no queden restos en el
`preflight` de `up`. Si alguna vez lo hacés a mano:

```bash
az group delete -n rg-metaverso-databricks-managed --yes
```

## Los límites de Azure for Students (leer antes de tocar SKUs o región)

Una suscripción de estudiante impone **tres restricciones distintas a la vez**. Las tres
fallan de forma diferente, y confundirlas cuesta horas:

| Restricción | Qué pasa si la violás |
|---|---|
| **Política de regiones permitidas** | `403 RequestDisallowedByAzure`. No es cuota: Azure directamente prohíbe la región. |
| **6 vCPUs totales** por región | Error de cuota al crear la VM o el cluster. |
| **4 vCPUs por familia** de VM | Error de cuota — y aparece en el recurso equivocado. |

**Las regiones permitidas** son solo cinco (verificalas, pueden cambiar):

```bash
az policy assignment list --query "[].parameters" -o json
# -> southcentralus, brazilsouth, eastus2, mexicocentral, canadacentral
```

De ahí sale este reparto, que **entra exacto y sin margen**:

| Recurso | SKU | Familia | vCPUs |
|---|---|---|---|
| VM de la app | `Standard_E2s_v3` | ESv3 (límite 4) | 2 |
| Nodo de Databricks | `Standard_D4s_v3` | DSv3 (límite 4) | 4 |
| | | **Total** | **6 / 6** |

**Están en familias distintas a propósito.** En la misma familia se comerían los 4 vCPUs
entre ellas y el cluster nunca arrancaría — con un error de *cuota* que aparece en
Databricks, sin nada que apunte a la VM que se comió el presupuesto.

### `Zone` vs `Location`: la distinción que lo decide todo

Al mirar si un SKU sirve, **no alcanza con ver si tiene restricciones**: hay que ver de
qué **tipo** son.

```bash
az vm list-skus -l eastus2 --resource-type virtualMachines --all \
  --query "[?name=='Standard_D4s_v3'].{tipo:restrictions[0].type, motivo:restrictions[0].reasonCode}" -o table
```

- **`type = Zone`** → **usable**. Solo está bloqueado para despliegues fijados a una zona
  de disponibilidad. Ni la VM ni Databricks fijan zona (`zone_id` es un concepto de AWS),
  así que despliegan sin problema.
- **`type = Location`** → **genuinamente no disponible** para tu suscripción.

> Filtrar por "SKUs sin ninguna restricción" es la trampa: esconde SKUs perfectamente
> usables. `Standard_D4s_v3` y `Standard_E2s_v3` tienen las tres zonas restringidas y aun
> así funcionan.

Cuotas por familia: `az vm list-usage -l eastus2 -o table`.

> Databricks debe ser SKU **premium**: Azure retiró el tier Standard
> (`DatabricksStandardSkuNotSupported`).

## Requisitos

- Terraform >= 1.5 (o OpenTofu)
- Azure CLI autenticado: `az login`
- Suscripción activa (Azure for Students)
- **El repositorio debe ser público**: cloud-init lo clona por HTTPS sin
  credenciales para desplegar la app en la VM (o pasar `repo_url` con token).

## Despliegue

Todo el ciclo de vida está automatizado en `scripts/deploy-azure.sh` (desde la
raíz del repo). El script no reemplaza a Terraform: lo orquesta, y todo lo que
crea es declarativo.

```bash
make deploy            # infra + app en la VM + job del detector (creado PAUSADO)
make detector-start    # detector ON  — arranca el job-cluster de Databricks
make deploy-status     # IP, web, estado de la VM y del detector
make detector-stop     # detector OFF — termina el cluster: vuelve a $0/hora
make deploy-down       # terraform destroy de todo
```

`make deploy` hace, en orden:

1. **Preflight**: `az login` activo; el repo es **público** y tu HEAD está
   **pusheado** (cloud-init clona GitHub anónimamente — si el repo es privado la
   VM arranca vacía, y si no pusheaste despliega código viejo, en ambos casos con
   el `apply` en verde).
2. Genera `infra/terraform.tfvars` (email del presupuesto, llave SSH — la crea si
   no existe, `repo_url` derivado de tu `origin`).
3. `terraform apply` en `infra/` — Azure.
4. `terraform apply` en `infra/databricks/` — el job de Spark, cableado con los
   outputs del paso anterior y con la calibración leída de `env/env.prod.example`.
5. Escribe `.env.azure` (perfil listo para correr el detector/metaverso local
   contra Azure: `cp .env.azure .env`).
6. Espera a que cloud-init termine y la web responda 200.

Variables opcionales: `BUDGET_EMAIL`, `SSH_PUBLIC_KEY_FILE`, `ENABLE_ARCHIVE=true`
(archiva el histórico de posiciones en ADLS).

### Las dos etapas de Terraform

`infra/databricks/` es un módulo raíz aparte, no un capricho: el provider
`databricks` necesita la URL del workspace, y **un provider no se puede
configurar con un valor que se crea en el mismo `apply`**. Separarlos hace que
cada etapa sea aplicable y re-aplicable sola.

### El detector: encendido y apagado

El job se crea **continuo y pausado**. `detector_running` es el interruptor:
pausarlo cancela el run, lo que termina el job-cluster — el único recurso que
cobra por hora. Por eso el detector apagado cuesta $0 y no hay que acordarse de
apagar ningún cluster a mano después de la demo.

Databricks exporta las variables de entorno del job **a través de bash**, así que
el módulo las escribe entre comillas: sin ellas la connection string de Event Hubs
se cortaría en su primer `;` y `10 seconds` se partiría en dos palabras. El
detector las lee con un `env()` que tolera comillas, así que el mismo valor es
correcto en local y en Databricks.

### Verificación end-to-end

1. Navegador → `http://<vm_public_ip>` → crear sala como admin.
2. Usuarios se unen con el código, configuran flotas grandes y las invocan.
3. Al formarse una cola (≥7 detenidos ~5 s en una celda), la zona se pinta de
   roja y las rutas la esquivan; al drenarse, se apaga en ~15-20 s.
4. Si no aparecen zonas: `make deploy-status` (¿el detector está ON?), el run en
   la UI de Databricks, y el heartbeat del backend
   (`journalctl -u metaverse-server | grep heartbeat` — `redpoints:` debe crecer).

Si la web no carga, diagnosticar por SSH:

```bash
ssh azureuser@<ip>
sudo cat /var/log/cloud-init-output.log   # ¿falló el clone/build?
systemctl status metaverse-server         # ¿corre el backend?
```

### Después de cada demo

```bash
make detector-stop                  # imprescindible: es lo que cobra por hora
./scripts/deploy-azure.sh vm-stop   # opcional: la VM son ~$30/mes prendida
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
| **$40** (`budget_amount`) | Email + **kill-switch**: desasigna la VM y **pausa** los jobs de Databricks. |

El runbook **no borra nada**: desasigna la VM (una VM "detenida" sigue cobrando; una
*desasignada* no) y pausa los jobs. Volvés con `make detector-start` y
`./scripts/deploy-azure.sh vm-start`.

**Por qué pausa y no solo cancela:** el detector es un job **continuo**. Si solo se
cancelara el run, Databricks lo reiniciaría solo y el cluster —y la factura— volverían.

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
`make deploy` otra vez (agrega los 9 recursos del kill-switch, no toca nada más).

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
cupo (horas) o aplicá el resto sin el kill-switch:

```bash
terraform -chdir=infra apply \
  -target=azurerm_linux_virtual_machine.app -target=azurerm_eventhub_namespace.main
```

### Probalo ANTES de necesitarlo

Un kill-switch que nunca se ejecutó es una suposición, no una protección. Después del
primer `make deploy`, disparalo a mano una vez y mirá que la VM quede `deallocated`:

```bash
az automation runbook start \
  --resource-group rg-metaverso-governance \
  --automation-account-name aa-metaverso-killswitch \
  --name Stop-BillableCompute

az vm show -d -g rg-metaverso-app -n vm-metaverso-app --query powerState -o tsv
# -> "VM deallocated"
```

Si el runbook falla por módulos de PowerShell faltantes (`Az.Accounts` / `Az.Compute`),
importalos desde la galería en el Automation Account — es la única dependencia externa
que tiene.

Ajustar los montos: `budget_alert_amount` (aviso) y `budget_amount` (corte) en
`infra/terraform.tfvars`.

> ⚠️ En prod el checkpoint guarda los offsets de Event Hubs: cambios de
> ventana/agregación del detector requieren un plan de migración del
> checkpoint, no un borrado alegre como en dev.

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
Event Hubs y Storage están listados; Databricks, VM y Consumption Budget
probablemente NO — si el `apply` falla en esos recursos contra Floci, es
esperado (se validan solo contra Azure real con `terraform plan`).

## Destruir todo

```bash
terraform destroy
```

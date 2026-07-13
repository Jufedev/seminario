# Infraestructura Azure — Terraform

Provisiona la arquitectura de analítica en tiempo real (ver `docs/arquitectura.drawio`),
repartida en cuatro resource groups (`network`, `compute`, `bigdata`, `storage`):

| Recurso | Nombre | Rol | Costo estimado |
|---|---|---|---|
| VM Ubuntu 22.04 (B2s) + IP pública | `vm-metaverso-app` | Frontend (nginx :80) + backend (bun :8080), auto-provisionada por cloud-init | ~$30/mes prendida — apagarla cuando no se use |
| VNet + subnet pública + NSG | `vnet-metaverso` | Red de la VM (puertos 22, 80 y 8080) | Gratis |
| Event Hubs (Standard, 1 TU) | `evhns-metaverso-*` | Kafka administrado: `avatar-positions`, `red-points` y `sim-events` (topics internos consolidados — el tier Standard permite máx. 10 hubs) | ~$11/mes fijo |
| Storage ADLS Gen2 (LRS) | `stmetaverso*` | Archivo histórico de eventos (Big Data) | Centavos/mes |
| Databricks (Standard) | `dbw-metaverso` | Ejecuta el job de Spark | $0 sin cluster; ~$0.50/hora con cluster single-node prendido |
| Job de Spark (`infra/databricks/`) | `red-point-detector` | El detector, como job continuo sobre un job-cluster single-node | $0 pausado; ~$0.50/hora corriendo |
| Budget alert (suscripción) | `budget-metaverso` | Aviso por email al 80% de $50/mes | Gratis |

**Nota**: Event Hubs debe ser tier **Standard** — Basic no soporta el protocolo Kafka.

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

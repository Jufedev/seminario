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
| Budget alert (suscripción) | `budget-metaverso` | Aviso por email al 80% de $50/mes | Gratis |

**Nota**: Event Hubs debe ser tier **Standard** — Basic no soporta el protocolo Kafka.

## Requisitos

- Terraform >= 1.5 (o OpenTofu)
- Azure CLI autenticado: `az login`
- Suscripción activa (Azure for Students)
- **El repositorio debe ser público**: cloud-init lo clona por HTTPS sin
  credenciales para desplegar la app en la VM (o pasar `repo_url` con token).

## Despliegue a Azure real

```bash
cd infra
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Variables obligatorias (terraform.tfvars está gitignoreado a propósito):
cat > terraform.tfvars <<'EOF'
budget_contact_emails = ["correo@ejemplo.com"]
vm_ssh_public_key     = "ssh-ed25519 AAAA... usuario@maquina"
EOF

terraform init
terraform validate
terraform plan      # revisar: ~20 recursos a crear
terraform apply
```

## Después del `apply` — paso a paso para poner a correr el proyecto

### 1. Verificar la VM (automática, ~5 minutos)

cloud-init instala bun y nginx, clona el repo, buildea el cliente y deja el
backend corriendo como servicio systemd con las credenciales de Event Hubs ya
inyectadas por Terraform. No hay que copiar nada a mano.

```bash
terraform output vm_public_ip
# Abrir http://<esa-ip> en el navegador → debe cargar el metaverso
```

Si no carga, diagnosticar por SSH:

```bash
ssh azureuser@<ip>
sudo cat /var/log/cloud-init-output.log   # ¿falló el clone/build?
systemctl status metaverse-server         # ¿corre el backend?
journalctl -u metaverse-server -n 50      # sus logs
```

### 2. Databricks — el detector Spark (manual, la única pieza que falta)

El workspace se crea VACÍO; sin este paso **no hay zonas rojas**:

1. Entrar al workspace: `terraform output databricks_workspace_url`
2. Crear un cluster **single-node** (Standard_DS3_v2 o menor) con
   auto-terminate de 30 min.
3. Subir `pipeline/red_point_detector.py` como job.
4. Configurar las variables de entorno del job:

   ```
   KAFKA_BOOTSTRAP             = (terraform output kafka_bootstrap)
   EVENTHUBS_CONNECTION_STRING = (terraform output -raw eventhubs_connection_string)
   CELL_SIZE_X=30  CELL_SIZE_Y=30  GRID_ORIGIN_X=-240  GRID_ORIGIN_Y=-195
   WINDOW_DURATION=10 seconds   WINDOW_SLIDE=5 seconds
   MIN_MEAN_DWELL_S=5           MIN_STATIONARY_AVATARS=7
   CHECKPOINT_DIR=dbfs:/checkpoints/red-point-detector
   ARCHIVE_PATH=abfss://avatar-events@<cuenta>.dfs.core.windows.net/positions   # opcional
   ```

   La cuenta de storage sale de `terraform output datalake_account`.
5. Ejecutar el job y dejarlo corriendo durante la demo.

> ⚠️ En prod el checkpoint guarda los offsets de Event Hubs: cambios de
> ventana/agregación del detector requieren un plan de migración del
> checkpoint, no un borrado alegre como en dev.

### 3. Verificación end-to-end

1. Navegador → `http://<vm_public_ip>` → crear sala como admin.
2. Usuarios se unen con el código, configuran flotas grandes y las invocan.
3. Al formarse una cola (≥7 detenidos ~5 s en una celda), la zona se pinta de
   roja y las rutas la esquivan; al drenarse, se apaga en ~15-20 s.
4. Si no aparecen zonas: revisar que el job de Databricks esté corriendo y
   mirar el heartbeat del backend (`journalctl -u metaverse-server | grep heartbeat`
   — `redpoints:` debe crecer).

### 4. Después de cada demo

- **Apagar el cluster de Databricks** — es el único recurso que cobra por hora.
- Opcional: desasignar la VM (`az vm deallocate -g rg-metaverso-compute -n vm-metaverso-app`)
  para no consumir sus ~$30/mes fuera de las demos.

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

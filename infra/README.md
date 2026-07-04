# Infraestructura Azure — Terraform

Provisiona la arquitectura de analítica en tiempo real:

| Recurso | Nombre | Rol | Costo estimado |
|---|---|---|---|
| Event Hubs (Standard, 1 TU) | `evhns-metaverso-*` | Kafka administrado: topics `avatar-positions` y `red-points` | ~$11/mes fijo |
| Storage ADLS Gen2 (LRS) | `stmetaverso*` | Archivo histórico de eventos (Big Data) | Centavos/mes |
| Databricks (Standard) | `dbw-metaverso` | Ejecuta el job de Spark | $0 sin cluster; ~$0.50/hora con cluster single-node prendido |
| Budget alert | `budget-metaverso` | Aviso por email al 80% de $50/mes | Gratis |

**Nota**: Event Hubs debe ser tier **Standard** — Basic no soporta el protocolo Kafka.

## Requisitos

- Terraform >= 1.5 (o OpenTofu)
- Azure CLI autenticado: `az login`
- Suscripción activa (Azure for Students)

## Despliegue a Azure real

```bash
cd infra
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)

terraform init
terraform plan -var 'budget_contact_emails=["correo@ejemplo.com"]'
terraform apply -var 'budget_contact_emails=["correo@ejemplo.com"]'
```

Al finalizar, obtener las variables para el job de Spark:

```bash
terraform output kafka_bootstrap
terraform output -raw eventhubs_connection_string
```

Esos dos valores son `KAFKA_BOOTSTRAP` y `EVENTHUBS_CONNECTION_STRING` — el
mismo código local corre contra Azure sin modificaciones.

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
Event Hubs y Storage están listados; Databricks y Consumption Budget
probablemente NO — si el `apply` falla en esos recursos contra Floci, es
esperado (se validan solo contra Azure real con `terraform plan`).

## Qué NO está en Terraform (pasos manuales en Databricks)

1. Crear un cluster **single-node** (Standard_DS3_v2 o menor) con auto-terminate de 30 min.
2. Subir `analytics/red_point_detector.py` como job.
3. Configurar las variables de entorno del job (`KAFKA_BOOTSTRAP`, `EVENTHUBS_CONNECTION_STRING`, parámetros de detección).
4. **Apagar el cluster después de cada demo** — es el único recurso que consume crédito por hora.

## Destruir todo

```bash
terraform destroy -var 'budget_contact_emails=["correo@ejemplo.com"]'
```

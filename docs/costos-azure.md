# Costos de Azure — cuánto cuesta la demo

**En una línea: con todo desplegado y el detector corriendo, la demo cuesta ≈ $0.19 por hora
(≈ $4.50 por día si la dejás prendida). Una demo de verdad son minutos, así que son centavos —
lo caro es olvidarse de apagarla.**

Los números están **verificados contra la factura real** de esta suscripción (Azure Cost
Management, despliegue del 2026-07-13/14), no estimados. Suscripción: **Azure for Students**
($100 de crédito). Región: **eastus2**. Moneda: **USD**.

---

## Todo desplegado (lo que corre durante la demo)

| Recurso | Qué hace | Costo por hora |
|---|---|---|
| VM de la app | Sirve el metaverso (web + servidor) | $0.133 |
| Event Hubs (Standard, 1 TU) | El bus Kafka entre el metaverso y Spark | $0.030 |
| Registro de contenedores (ACR) | Guarda la imagen del detector | $0.007 |
| IP pública + disco de la VM | Dirección fija y disco de sistema | $0.007 |
| Detector (Spark en contenedor) | **Gratis** las primeras ~25 h del mes; después $0.216/h | $0.000 |
| Log Analytics, ADLS, red, budget, kill-switch | — | Gratis / centavos |
| **TOTAL con la demo corriendo** | | **≈ $0.19 / h** |
| **TOTAL si la dejás prendida un día entero** | | **≈ $4.50 / día** |

> **¿Por qué el detector sale $0?** Azure regala 25 horas de detector por mes. Una demo normal
> entra ahí y no paga cómputo del detector. Pasadas esas 25 h, suma $0.216/h — igual, sigue
> costando menos que la VM. **Lo caro del despliegue es la VM, no el detector.**

---

## Cómo apagarlo (leé esto, es donde se va la plata)

**Solo un comando deja el gasto en $0. Los otros dos NO.**

| Comando | Qué apaga | Costo después |
|---|---|---|
| `make detector-stop` | Solo el detector | **≈ $0.177 / h** (la VM y Event Hubs siguen cobrando) |
| `./scripts/deploy-azure.sh vm-stop` | El detector y la VM | **≈ $0.044 / h** (~$32/mes — sobre todo Event Hubs) |
| `make deploy-down` | **TODO lo que cobra** | **$0.00** ✅ |

**La regla para el equipo: al terminar de grabar, `make deploy-down`.** No `detector-stop`, no
`vm-stop`. Destruir. El stack se vuelve a levantar con un comando cuando lo necesiten.

> Dejar el stack desplegado y "apagado" con `detector-stop` quema el crédito de $100 en **~23
> días** sin correr una sola demo. Por eso el estado por defecto entre demos es **destruido**,
> no apagado. (El presupuesto y el kill-switch **sobreviven** a `deploy-down` a propósito, y
> cuestan $0.)

---

## La prueba: lo que Azure facturó de verdad

Gasto total del proyecto en Azure **en toda su historia: $0.43.** Esto es lo que cobró la
suscripción (Azure Cost Management, período 2026-07-01 → 07-14):

| USD | Servicio |
|---|---|
| 0.2150 | VM |
| 0.0600 | Event Hubs (throughput unit) |
| 0.0312 | IP pública |
| 0.0072 | Event Hubs (eventos de ingreso) |
| 0.0053 | Registro (ACR) |
| 0.0035 | Disco |
| ~0 | Storage (operaciones) |
| **0.4270** | **TOTAL** |

Dos cosas que la factura confirma, y que suelen confundir:

- **Container Apps aparece en $0.00** — la cuota gratis cubrió el detector entero.
- **No existe ningún cargo por "Kafka endpoint".** El protocolo Kafka viene **incluido** en
  Event Hubs Standard; lo que se cobra es el throughput unit y los eventos, nada más.

> Los datos de costo de Azure **llegan con horas de retraso**, así que el budget no es un freno
> de mano: cuando "vea" el gasto, ya pasó. El único freno confiable es `make deploy-down`.

---

## Re-verificar los números (cuando quieras)

Los precios de Azure cambian. Para reproducir el precio de un recurso (API pública, sin sesión):

```bash
curl -s "https://prices.azure.com/api/retail/prices?currencyCode='USD'&\$filter=armRegionName%20eq%20'eastus2'%20and%20serviceName%20eq%20'Event%20Hubs'" \
  | python3 -m json.tool | rg -A3 'Standard Throughput Unit'
```

Para ver lo que **realmente** te facturaron (necesita `az login`):

```bash
SUB=$(az account show --query id -o tsv)
az rest --method post \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.CostManagement/query?api-version=2024-08-01" \
  --body '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None","aggregation":{"cost":{"name":"Cost","function":"Sum"}},"grouping":[{"type":"Dimension","name":"ServiceName"}]}}'
```

**Un precio de lista es una promesa; la factura es un hecho.**

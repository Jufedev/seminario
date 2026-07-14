# Costos de Azure — qué se cobra, por hora, y por qué

Este documento tiene **un solo trabajo**: decir cuánto cuesta el despliegue por hora, sin
redondeos optimistas.

Los números NO salen de estimaciones ni de otros documentos del repo. Salen de dos fuentes,
y las dos se pueden reproducir:

1. **La API pública de precios retail de Azure** (`https://prices.azure.com/api/retail/prices`),
   filtrada por `armRegionName eq 'eastus2'` — la región donde efectivamente despliega este
   proyecto. De ahí sale **el precio unitario de cada meter**.
2. **La facturación real de esta suscripción** (Azure Cost Management), del despliegue del
   2026-07-13/14. De ahí sale **qué meters se encienden de verdad** — que es la parte que
   ninguna estimación te puede dar.

> **Este archivo es la fuente de verdad de los costos.** El `README.md` y el
> `infra/README.md` citan estos mismos números, redondeados, para que los tengas a mano donde
> los necesitás — pero si alguno difiere, **el que manda es este**, y hay que corregir el otro.
> Las [tres trampas](#5-las-tres-trampas-de-este-pricing) que hacen que estos precios se citen
> mal están en §5.

Suscripción: **Azure for Students** ($100 de crédito, 12 meses). Un crédito no cambia los
precios: se consume a **tarifa pay-as-you-go retail**. Todo lo de acá abajo es lo que se le
descuenta al crédito.

Región: **eastus2**. Moneda: **USD**. Los precios de Azure cambian; el
[método para re-verificarlos](#cómo-re-verificar-todo-esto) está al final.

---

## 1. El inventario que cobra

Lo primero es separar lo que cuesta de lo que no. El despliegue crea unos 25 recursos y **la
mayoría son gratis** — lo que confunde a cualquiera que abra el portal y vea seis resource
groups.

Cobran **ocho recursos**, a través de **diez meters** de facturación (Event Hubs cobra por dos
—capacidad reservada y eventos— y el detector también —vCPU y memoria—):

| Recurso | Meter de facturación | Precio |
|---|---|---|
| VM de la app (`Standard_E2s_v3`, Linux, **encendida**) | `Virtual Machines / E2 v3/E2s v3` | **$0.1330 / h** |
| IP pública (Standard, estática) | `Standard IPv4 Static Public IP` | **$0.0050 / h** |
| Disco de SO (32 GiB, Standard HDD → tier **S4**) | `S4 LRS Disk` | $1.536 / mes = **$0.0021 / h** |
| Event Hubs **Standard**, 1 throughput unit | `Standard Throughput Unit` | **$0.0300 / h** |
| Event Hubs — eventos de ingreso | `Standard Ingress Events` | $0.028 / millón de eventos |
| Registro de contenedores (ACR **Basic**) | `Basic Registry Unit` | $0.1666 / día = **$0.0069 / h** |
| Detector — vCPU activa (2 vCPU) | `Standard vCPU Active Usage` | $0.000024 / vCPU-s = **$0.1728 / h** |
| Detector — memoria activa (4 GiB) | `Standard Memory Active Usage` | $0.000003 / GiB-s = **$0.0432 / h** |
| Log Analytics (ingesta) | `Analytics Logs Data Ingestion` | $2.76 / GB — **5 GB/mes gratis** |
| ADLS Gen2 (checkpoint de Spark) | `Hot LRS ...` (varios) | centavos; ver §4 |

No cobra **nada**: la VNet, la subnet, el NSG, la NIC, el budget, la identidad administrada, el
Automation Account del kill-switch (500 minutos de job gratis al mes; el runbook corre segundos),
y el **entorno de Container Apps** — porque es perfil *Consumption*, no *Dedicated* (el plan
Dedicated sí cobraría $0.10/h de "plan management"; este despliegue no lo usa).

### El detector tiene 25 horas gratis al mes, y son exactas

Container Apps Consumption regala, **por suscripción y por mes**, 180.000 vCPU-segundos y
360.000 GiB-segundos. El detector pide 2 vCPU y 4 GiB, así que:

```
180.000 vCPU-s ÷ 2 vCPU = 90.000 s = 25,0 h
360.000 GiB-s  ÷ 4 GiB  = 90.000 s = 25,0 h
```

Las dos cuotas se agotan **al mismo tiempo**: **25 horas de detector por mes, a costo cero.**
El dimensionado 2 vCPU / 4 GiB no es casual — es exactamente la proporción que hace que ninguna
de las dos cuotas se desperdicie.

Y esto se confirma en la factura real: en el despliegue del 13/14, **Container Apps aparece en
$0.00**. La cuota gratis se comió el detector entero.

**Pasada esa cuota**, el detector cuesta $0.1728 + $0.0432 = **$0.2160 / h**.

---

## 2. Los cuatro escenarios (esto es lo que hay que saber)

### A. Desplegado, detector APAGADO, VM encendida
*Lo que deja `make detector-stop`.*

| | |
|---|---|
| VM | $0.1330 |
| Event Hubs (1 TU) | $0.0300 |
| ACR Basic | $0.0069 |
| IP pública | $0.0050 |
| Disco de SO | $0.0021 |
| **TOTAL** | **≈ $0.177 / h ≈ $4.25 / día** |

### B. Detector ENCENDIDO, VM encendida, demo con tráfico
*El costo de correr la demo de verdad.*

| | Dentro de las 25 h gratis | Pasadas las 25 h |
|---|---|---|
| Base (escenario A) | $0.177 | $0.177 |
| Detector (Container Apps) | **$0.000** | $0.216 |
| Ingreso a Event Hubs (~100 avatares a 1 Hz = 360k ev/h × $0.028/millón) | $0.010 | $0.010 |
| **TOTAL** | **≈ $0.19 / h** | **≈ $0.40 / h** |

Una demo normal cae en la columna izquierda. **El detector no es lo caro; la VM lo es.**

> El ingreso de `sim-events` (los eventos internos de la simulación) suma algo por encima de esos
> $0.010, pero es de volumen bajo y **no se midió por separado**. El orden de magnitud no cambia:
> en la factura real, todo el ingreso a Event Hubs de las dos jornadas sumó **$0.0072**.

### C. VM DESASIGNADA (`./scripts/deploy-azure.sh vm-stop`), detector apagado
*El residuo que nadie mide — y donde está la sorpresa.*

| | |
|---|---|
| VM (desasignada) | $0.0000 |
| **Event Hubs (1 TU)** | **$0.0300** ← lo más caro que queda |
| ACR Basic | $0.0069 |
| IP pública (sigue cobrando) | $0.0050 |
| Disco de SO (sigue cobrando) | $0.0021 |
| **TOTAL** | **≈ $0.044 / h ≈ $1.06 / día ≈ $32 / mes** |

Tres cosas de este escenario merecen decirse en voz alta:

- **Una IP pública estática cobra aunque la VM esté desasignada.** Está reservada para vos: eso
  es lo que estás pagando. Lo mismo el disco: el disco es *almacenamiento*, no *cómputo*, y
  desasignar la VM no lo borra.
- **Después de `vm-stop`, el recurso más caro que queda es Event Hubs**, no la IP ni el disco.
  $0.03/h es casi el 70% del residuo, y cobra **exista o no exista tráfico** — un throughput
  unit se paga por estar reservado, no por usarse.
- Si el proyecto queda "apagado" un mes entero en este estado, son **$32** del crédito de $100.
  Un tercio del presupuesto, sin correr una sola demo.

### D. `make deploy-down`
**$0.00 / h.** Es el único estado que de verdad no cobra nada. Y es el correcto entre demos.

---

## 3. Cuánto dura el crédito de $100

| Estado | Costo / h | El crédito de $100 dura |
|---|---|---|
| Demo corriendo (detector ON, dentro de la cuota gratis) | $0.19 | ~526 h |
| Desplegado, detector apagado, VM encendida | $0.177 | ~565 h ≈ **23,5 días** |
| VM desasignada (solo el residuo) | $0.044 | ~2.270 h ≈ **95 días** |
| Todo destruido | $0.00 | para siempre |

**La lectura correcta:** dejar el stack desplegado y "apagado" quema el crédito en **tres
semanas**. El proyecto no tiene tres semanas de margen. El estado por defecto entre demos tiene
que ser **`make deploy-down`**, no `detector-stop`.

### Los umbrales del budget, en horas

El presupuesto de `infra/governance/` avisa a los $10 y a los $30, y el kill-switch corta a los $40.
Traducido a tiempo real, con el stack desplegado y la VM encendida ($0.177/h):

| Umbral | Cuándo lo tocás |
|---|---|
| $10 (aviso) | a las ~56 h ≈ 2,4 días |
| $30 (aviso) | a las ~170 h ≈ 7 días |
| $40 (**kill-switch**) | a las ~226 h ≈ 9,4 días |

> ⚠️ **El budget no es un freno de mano.** Los datos de costo de Azure **llegan con horas de
> retraso**: cuando el budget "vea" los $40, el gasto real ya puede ser mayor. El único freno
> confiable es `make deploy-down`.

---

## 4. Lo que efectivamente se facturó (la prueba)

Consumo real de esta suscripción, del despliegue del 2026-07-13/14 (Azure Cost Management,
`ActualCost`, período 2026-07-01 → 2026-07-14):

| USD | Servicio | Meter |
|---|---|---|
| 0.2150 | Virtual Machines | `E2 v3/E2s v3` |
| 0.1047 | NAT Gateway | `Standard Gateway` |
| 0.0600 | Event Hubs | **`Standard Throughput Unit`** |
| 0.0312 | Virtual Network | **`Standard IPv4 Static Public IP`** |
| 0.0072 | Event Hubs | `Standard Ingress Events` |
| 0.0053 | Container Registry | `Basic Registry Unit` |
| 0.0035 | Storage | `S4 LRS Disk` |
| ~0 | Storage | operaciones Hot (LRS/ZRS) |
| **0.4270** | | **TOTAL del proyecto hasta hoy** |

Esta tabla es la que **cierra tres discusiones**:

1. **No hay ningún cargo por "Kafka endpoint".** El price sheet de Azure tiene un meter llamado
   `Standard Kafka Endpoint` a $0.09/h que asusta al verlo — pero **no aparece en la factura**, y
   Microsoft documenta la integración con Kafka como una **feature incluida** en el tier Standard.
   Lo que se cobra es el throughput unit y los eventos de ingreso, nada más. Confirmado por los
   dos lados: el meter no factura, y la doc lo dice.
2. **La IP pública cobra**, y ningún documento del repo la mencionaba. Ahí está, facturada.
3. **La línea de NAT Gateway corresponde a un recurso que el despliegue actual NO crea.** Aparece
   únicamente en el primer día del período facturado y no vuelve a aparecer.

Y lo que **no** aparece en la factura también dice algo: **Container Apps: $0.00** (la cuota
gratis cubrió el detector completo) y **Log Analytics: $0.00** (bajo los 5 GB/mes gratis).

Desglose por día:

| Día | Total | Detalle |
|---|---|---|
| 2026-07-13 | $0.2878 | VM 0.122 · **`Standard Gateway` 0.105** · Event Hubs 0.033 · IP 0.026 · resto 0.002 |
| 2026-07-14 | $0.1392 | VM 0.093 · Event Hubs 0.035 · ACR 0.005 · IP 0.005 · resto 0.001 |

> **Nota sobre precisión:** los datos de costo de Azure **llegan con retraso** (típicamente 8 a
> 24 h) y cada meter aterriza a su propio ritmo. Por eso estos totales **no cierran** contra
> "horas × precio" y no hay que forzarlos: sirven para probar **qué meters se encienden**, no
> para derivar la tarifa. La tarifa sale de la API de precios (§1).

---

## 5. Las tres trampas de este pricing

Son las tres cosas que un lector apurado da por sentadas y que le van a costar plata.

**1. El tier importa, y el barato no sirve.** Event Hubs **Basic** cuesta $0.015/h por
throughput unit — la mitad. Pero **Basic no habla el protocolo Kafka**, así que este proyecto
no puede usarlo. El precio que aplica es el de **Standard: $0.0300/h**. Copiar el número de
Basic porque aparece primero en la página de precios es el error más fácil de cometer.

**2. Un throughput unit se paga por estar RESERVADO, no por usarse.** Event Hubs cobra sus
$0.030/h con tráfico o sin tráfico, con el detector prendido o apagado, y **sobrevive a
`vm-stop`**. Por eso, apenas desasignás la VM, el mayor gasto del despliegue **deja de ser la
VM y pasa a ser Event Hubs**.

**3. "Desasignar la VM" no apaga todo lo de la VM.** La **IP pública** ($0.005/h) y el **disco
de SO** ($0.0021/h) siguen cobrando con la VM desasignada — son *almacenamiento reservado*, no
cómputo. Son centavos, pero son los centavos que nadie ve venir porque no aparecen en ninguna
lista de "recursos de cómputo".

> **La regla que las cubre a las tres:** un precio de lista es una promesa; la factura es un
> hecho. Cualquier número de este archivo se re-verifica con los dos comandos de abajo — no
> se hereda de otro documento.

---

## 6. Reglas prácticas

1. **Entre demos: `make deploy-down`.** No `detector-stop`, no `vm-stop`. Destruir. Es el único
   estado a $0, y el stack se recrea con un comando.
2. **Si tenés que dejarlo desplegado, desasigná la VM** (`./scripts/deploy-azure.sh vm-stop`):
   baja de $0.177/h a $0.044/h. Pero sabé que **seguís pagando $32/mes**, sobre todo por Event
   Hubs.
3. **El detector no es el problema de costo.** Prenderlo dentro de la cuota mensual es gratis, y
   aun fuera de ella cuesta menos que la VM. Prendelo sin culpa; **apagá la VM.**
4. **El presupuesto real de una demo** (2 h de deploy + demo + destruir) es **menos de $0.50**.
   El crédito da para decenas de demos. Lo que **no** perdona es dejar el stack prendido de
   fondo: eso son $4.25 por día, sin que nadie lo esté usando.

---

## Cómo re-verificar todo esto

Los precios de Azure cambian. **No confíes en esta tabla dentro de seis meses — reproducila.**

**Precio unitario de un meter** (no necesita sesión de Azure, es una API pública):

```bash
curl -s "https://prices.azure.com/api/retail/prices?currencyCode='USD'&\$filter=armRegionName%20eq%20'eastus2'%20and%20serviceName%20eq%20'Event%20Hubs'" \
  | python3 -m json.tool | rg -A3 'Standard Throughput Unit'
```

**Lo que realmente te facturaron** (necesita `az login`):

```bash
SUB=$(az account show --query id -o tsv)
az rest --method post \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.CostManagement/query?api-version=2024-08-01" \
  --body '{
    "type": "ActualCost",
    "timeframe": "MonthToDate",
    "dataset": {
      "granularity": "None",
      "aggregation": { "cost": { "name": "Cost", "function": "Sum" } },
      "grouping": [
        { "type": "Dimension", "name": "ServiceName" },
        { "type": "Dimension", "name": "Meter" }
      ]
    }
  }'
```

La segunda es la que manda. **Un precio de lista es una promesa; la factura es un hecho.**

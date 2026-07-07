// ════════════════════════════════════════════════════════════════
//  CONSUMIDOR DE `red-points` (integración Spark) — la fuente de verdad
//  de las ZONAS ROJAS es el detector Big Data de Spark, NO la analítica
//  interna del metaverso. Este store lee el topic `red-points` (salida
//  del job pipeline/red_point_detector.py), traduce el centro de cada
//  celda al índice de zona 6×6 del metaverso y mantiene el conjunto de
//  zonas rojas ACTIVAS con TTL.
//
//  Correlación de sala: la salida de Spark agrupa por CELDA de mundo
//  sobre TODOS los avatares (avatar_id = "<sala>-<id>"), y el red-point
//  no lleva la sala. El mapa físico es UNO solo y compartido por todas
//  las salas, así que las zonas rojas son GLOBALES: se aplican a todas
//  las salas por igual. (Ver INTEGRATION REPORT / server/index.js.)
//
//  Modo local (sin broker → sin Spark): el store queda vacío. No hay
//  detección interna de respaldo a propósito: Spark es el detector de
//  registro; sin él, no hay zonas rojas.
// ════════════════════════════════════════════════════════════════
import { Kafka, logLevel } from 'kafkajs'
import { kafkaConfig } from '../server/kafkaConfig.js'
import { zoneIndexAt } from '../server/zoneGrid.js'

export const RED_POINTS_TOPIC = 'red-points'

// Spark re-emite cada celda roja en cada slide de la ventana (~10s, modo
// "update"). 30s de TTL sobrevive a un par de slides perdidos antes de apagar
// una zona que ya no se re-emite.
const TTL_MS = 30_000

export class RedPointStore {
  constructor({ bridge } = {}) {
    this.bridge = bridge
    this.zones = new Map()   // índice de zona 6×6 → epoch ms de expiración (global a todas las salas)
    this.mode = 'local'
    this.consumed = 0
  }

  async start() {
    // Preferir Kafka real; si el bridge quedó en local, escuchar el bus en-proceso.
    if (this.bridge?.mode === 'kafka') {
      try {
        const client = new Kafka({ ...kafkaConfig('ecci-redpoints'), logLevel: logLevel.NOTHING })
        // groupId efímero por proceso: las zonas rojas son estado VIVO con TTL.
        // Al reiniciar queremos SOLO detecciones actuales, nunca reproducir el
        // backlog acumulado durante la caída (eso resucitaría zonas viejas con
        // TTL fresco). Sin offset comprometido + fromBeginning:false ⇒ arranca
        // en el último offset y no revive detecciones obsoletas.
        const groupId = `ecci-redpoints-${process.pid}-${Date.now()}`
        this.consumer = client.consumer({ groupId })
        await this.consumer.connect()
        await this.consumer.subscribe({ topic: RED_POINTS_TOPIC, fromBeginning: false })
        await this.consumer.run({
          eachMessage: async ({ message }) => {
            try { this._ingest(JSON.parse(message.value.toString())) } catch { /* red-point corrupto */ }
          },
        })
        this.mode = 'kafka'
        console.log('[redpoints] consumidor Kafka activo (topic red-points) — zonas rojas desde Spark')
      } catch (err) {
        // El bridge está en modo kafka: publish() solo emite en el emitter local
        // cuando mode==='local', así que caer al bus local aquí nos dejaría
        // escuchando un bus MUERTO (nunca llegarían red-points). Fallar fuerte.
        this.mode = 'error'
        console.error(
          '[redpoints] FALLO conectando el consumidor de red-points contra Kafka:',
          err.message,
          '— NO habrá zonas rojas hasta reiniciar. Revisa broker/credenciales.',
        )
      }
    } else {
      this._attachLocal()
    }
  }

  _attachLocal() {
    this.mode = 'local'
    // Sin Spark en modo local no llegan red-points; el listener mantiene la
    // simetría del cableado (recogería red-points en-proceso si existieran).
    this.bridge?.emitter.on('event', ({ topic, event }) => {
      if (topic === RED_POINTS_TOPIC) this._ingest(event)
    })
    console.log('[redpoints] modo local (sin Spark: no habrá zonas rojas hasta conectar el detector)')
  }

  // Un red-point de Spark → refresca el TTL de su zona 6×6.
  _ingest(e) {
    this.consumed++
    // Spark emite center_x/center_y en las MISMAS coords de mundo que le
    // mandamos como x/y (three.js posX→x, posZ→y). Mapear el centro de la
    // celda de vuelta al índice de zona 6×6 del metaverso.
    const cx = Number(e.center_x), cy = Number(e.center_y)
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return
    const zone = zoneIndexAt(cx, cy)
    this.zones.set(zone, Date.now() + TTL_MS)
  }

  // Zonas rojas activas ahora (poda las expiradas). Global a todas las salas.
  activeZones() {
    const now = Date.now()
    const out = []
    for (const [zone, exp] of this.zones) {
      if (exp > now) out.push(zone)
      else this.zones.delete(zone)
    }
    return out
  }

  async dispose() {
    try { await this.consumer?.disconnect() } catch { /* cerrando */ }
  }
}

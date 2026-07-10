// ════════════════════════════════════════════════════════════════
//  CONSUMIDOR DE `red-points` (integración Spark) — la fuente de verdad
//  de las ZONAS ROJAS es el detector Big Data de Spark, NO la analítica
//  interna del metaverso. Este store lee el topic `red-points` (salida
//  del job pipeline/red_point_detector.py), traduce el centro de cada
//  celda al índice de la grilla de zonas del metaverso (dimensiones en
//  src/analytics/config.js) y mantiene el conjunto de zonas rojas
//  ACTIVAS con TTL.
//
//  Correlación de sala: Spark ahora emite cada red-point con un campo
//  `room` (el código de sala parseado del avatar_id). Las zonas rojas se
//  mantienen POR SALA. Un red-point sin `room` cae en una clave GLOBAL y
//  se aplica a todas las salas (compat + detecciones sin sala atribuible).
//  (Ver server/index.js: el tick pasa activeZonesFor(room.code) a cada sala.)
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
// "update"). 15s de TTL sobrevive a un slide perdido antes de apagar una
// zona que ya no se re-emite, y apaga rápido las zonas ya despejadas.
const TTL_MS = 15_000

// Clave para red-points sin sala atribuible: sus zonas las ven TODAS las salas.
export const GLOBAL_ROOM_KEY = '__global__'

export class RedPointStore {
  constructor({ bridge } = {}) {
    this.bridge = bridge
    // Zonas rojas POR SALA: roomKey → Map<índice de zona, epoch ms de expiración>.
    // La clave GLOBAL_ROOM_KEY agrupa los red-points sin sala (los ven todas).
    this.zones = new Map()
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
        // Un fallo del broker DESPUÉS del arranque (rebalanceo fallido, broker caído)
        // dispara CRASH: sin este listener el consumidor moriría en silencio y las
        // zonas rojas quedarían congeladas sin señal. Lo dejamos visible en el log.
        this.consumer.on(this.consumer.events.CRASH, e =>
          console.error('[redpoints] CRASH del consumidor Kafka:', e.payload?.error?.message ?? e.payload?.error, '— zonas rojas pueden quedar congeladas'))
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

  // Un red-point de Spark → refresca el TTL de su zona bajo la sala del evento.
  _ingest(e) {
    this.consumed++
    // Spark emite center_x/center_y en las MISMAS coords de mundo que le
    // mandamos como x/y (three.js posX→x, posZ→y). Mapear el centro de la
    // celda de vuelta al índice de la grilla de zonas del metaverso.
    const cx = Number(e.center_x), cy = Number(e.center_y)
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return
    const zone = zoneIndexAt(cx, cy)
    const key = e.room ?? GLOBAL_ROOM_KEY   // sin sala → clave global (la ven todas)
    let roomZones = this.zones.get(key)
    if (!roomZones) { roomZones = new Map(); this.zones.set(key, roomZones) }
    roomZones.set(zone, Date.now() + TTL_MS)
  }

  // Poda las zonas expiradas de un mapa de sala y devuelve las vivas en `out`.
  _collectLive(key, out, now) {
    const roomZones = this.zones.get(key)
    if (!roomZones) return
    for (const [zone, exp] of roomZones) {
      if (exp > now) out.add(zone)
      else roomZones.delete(zone)
    }
    if (roomZones.size === 0) this.zones.delete(key)   // no acumular salas muertas
  }

  // Zonas rojas activas de UNA sala: las suyas + las GLOBALES (poda expiradas).
  activeZonesFor(roomCode) {
    const now = Date.now()
    const out = new Set()
    if (roomCode != null) this._collectLive(roomCode, out, now)
    this._collectLive(GLOBAL_ROOM_KEY, out, now)
    return [...out]
  }

  // Legacy: unión de zonas activas de TODAS las salas (poda expiradas). Se mantiene
  // por compatibilidad; el tick usa activeZonesFor(room.code) por sala.
  activeZones() {
    const now = Date.now()
    const out = new Set()
    for (const key of [...this.zones.keys()]) this._collectLive(key, out, now)
    return [...out]
  }

  async dispose() {
    try { await this.consumer?.disconnect() } catch { /* cerrando */ }
  }
}

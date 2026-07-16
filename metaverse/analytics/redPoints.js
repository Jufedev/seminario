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

// Spark re-emite cada celda roja UNA VEZ POR SLIDE mientras la congestión dure
// (modo "update"). El slide calibrado es de 5s (WINDOW_SLIDE en env/), no los 10s
// del default del código: si dimensionás este TTL leyendo el .py, lo dimensionás
// contra parámetros que nadie usa.
//
// Con slide de 5s, 15s de TTL tolera DOS re-emisiones perdidas seguidas y recién
// se apaga en la tercera. Ese es el margen: suficiente para que un mensaje perdido
// no haga parpadear una zona viva, y corto para que una calle ya despejada se
// apague sola en ~15s (no existe evento de "bloqueo resuelto": la zona muere de
// hambre, no por aviso).
//
// OJO: este número está ACOPLADO a WINDOW_SLIDE. Si alguien alarga el slide, hay
// que alargar el TTL o las zonas van a parpadear.
const TTL_MS = 15_000

// Clave para red-points sin sala atribuible: sus zonas las ven TODAS las salas.
export const GLOBAL_ROOM_KEY = '__global__'

// Los bordes de ventana de Spark vienen como "2026-07-07 12:00:30" y son UTC: el
// detector fija spark.sql.session.timeZone=UTC justamente para que no dependan del
// reloj del host (ver red_point_detector.py). De ahí la 'Z'. Devuelve NaN si no
// parsea, y los llamadores tratan eso como fail-open: mejor un fantasma raro que
// perder detecciones.
const parseWindowTs = v => Date.parse(String(v).replace(' ', 'T') + 'Z')

export class RedPointStore {
  constructor({ bridge } = {}) {
    this.bridge = bridge
    // Zonas rojas POR SALA: roomKey → Map<índice de zona, epoch ms de expiración>.
    // La clave GLOBAL_ROOM_KEY agrupa los red-points sin sala (los ven todas).
    this.zones = new Map()
    // Reset POR SALA: roomCode → epoch ms del reset. Sirve para descartar los
    // red-points de ventanas que se cerraron ANTES del reset (ver _ingest y
    // markReset): tras un reset, Spark sigue emitiendo desde su ventana ya
    // abierta (armada con posiciones previas) por ~ventana+watermark.
    this.resetAt = new Map()
    // Muerte POR SALA: roomCode → epoch ms en que el barrido la destruyó. Es una
    // barrera hermana de resetAt, pero con la polaridad AL REVÉS (mira window_START,
    // no window_end). El porqué está en forgetRoom.
    this.deadAt = new Map()
    // Actividad del detector para el tablero: cuántos bloqueos DISTINTOS cazó
    // Spark en la corrida (celdas únicas, no re-emisiones) y cuándo fue el último.
    // Es lo que el metaverso NO puede medirse solo: el trabajo del Big Data.
    this.detectedCells = new Map()   // roomKey → Set<índice de zona detectado>
    this.lastDetectionAt = new Map() // roomKey → epoch ms de la última detección
    this.mode = 'local'
    this.consumed = 0
  }

  // El admin reinició la sala: (a) soltamos sus zonas vivas acumuladas y (b)
  // anotamos el instante del reset para descartar los red-points rezagados de
  // ventanas previas (Spark las sigue emitiendo hasta ~ventana+watermark). Es
  // POR SALA: no toca la clave global ni las demás salas.
  markReset(roomCode, resetAt = Date.now()) {
    this.zones.delete(roomCode)
    this.resetAt.set(roomCode, resetAt)
    // La corrida nueva empieza sin historial de detecciones: el tablero cuenta
    // lo que Spark caza EN ESTA corrida, no en la anterior.
    this.detectedCells.delete(roomCode)
    this.lastDetectionAt.delete(roomCode)
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
    // Post-reset: descartar los red-points de ventanas cerradas ANTES del reset de
    // ESTA sala (no la global: el reset es por sala). window_end viene como
    // "2026-07-07 12:00:30" y es UTC — el detector fija spark.sql.session.timeZone=UTC
    // justamente para que no dependa del reloj del host (ver red_point_detector.py). Por
    // eso agregamos 'Z'. Fail-open: si no parsea a un número finito, NO descartamos
    // (mejor un fantasma raro que perder detecciones).
    const resetAt = this.resetAt.get(key)
    if (resetAt != null) {
      const windowEnd = parseWindowTs(e.window_end)
      if (Number.isFinite(windowEnd) && windowEnd < resetAt) return
    }
    // Sala MUERTA cuyo código se recicló: descartar toda ventana que ARRANCÓ antes
    // de la muerte. Mirar el arranque y no el cierre es lo que distingue esta
    // barrera de la de reset — ver forgetRoom. Mismo fail-open.
    const deadAt = this.deadAt.get(key)
    if (deadAt != null) {
      const windowStart = parseWindowTs(e.window_start)
      if (Number.isFinite(windowStart) && windowStart < deadAt) return
    }
    let roomZones = this.zones.get(key)
    if (!roomZones) { roomZones = new Map(); this.zones.set(key, roomZones) }
    roomZones.set(zone, Date.now() + TTL_MS)
    // Registrar la actividad del detector para el tablero (celda distinta + hora).
    let cells = this.detectedCells.get(key)
    if (!cells) { cells = new Set(); this.detectedCells.set(key, cells) }
    cells.add(zone)
    this.lastDetectionAt.set(key, Date.now())
  }

  // La sala murió (barrido de salas vacías): se olvida TODO lo que este store
  // tenga indexado por su código.
  //
  // No es higiene, es corrección: `RoomManager.create()` evita los códigos de las
  // salas VIVAS, así que el de una sala destruida se recicla. Sin esto, la sala
  // nueva que caiga en ese código heredaría los contadores del detector de una
  // sesión ajena y ya muerta — y el tablero, cuyo único trabajo es reportar lo que
  // cazó Spark, le mostraría al jurado bloqueos que nadie detectó en esta corrida.
  // El TTL no salva a `detectedCells`/`lastDetectionAt`: son acumulados de la
  // corrida, no estado vivo, y por eso no vencen solos.
  //
  // La clave GLOBAL no se toca: no es de ninguna sala.
  //
  // Además de olvidar, LEVANTA una barrera en `deadAt`, y ahí está la parte sutil.
  // Spark sigue emitiendo los red-points de las ventanas que la sala muerta dejó
  // abiertas por ~ventana+watermark (con los defaults, ~60s: del mismo orden que
  // EMPTY_ROOM_TTL_MS, así que las dos ventanas SE SOLAPAN de verdad), y el `room`
  // del red-point es el código PELADO, sin epoch — a diferencia del avatar_id. Sin
  // barrera, esos rezagados entrarían como detecciones de la sala que recicle el
  // código.
  //
  // La barrera mira **window_start**, no window_end, y NO es la misma que la de
  // markReset. La diferencia es de fondo, no de estilo:
  //
  //   · markReset: la sala SIGUE VIVA. Una ventana a caballo del reset trae datos
  //     de antes Y de después, así que filtrarla por su arranque tiraría una
  //     detección legítima del run nuevo — y costaría hasta un slide de latencia,
  //     que es justo lo que la tesis mide. Por eso allá se mira el cierre.
  //   · forgetRoom: la sala está MUERTA y ya no produce nada. Cualquier ventana que
  //     arrancó antes de la muerte es dato de la muerta, con a lo sumo unos
  //     segundos de la sala nueva al final. Descartarla es correcto y no cuesta
  //     nada: la sala nueva recién arranca y no tiene atascos todavía.
  //
  // Mirar el arranque subsume mirar el cierre (toda ventana cerrada antes de la
  // muerte arrancó antes también), así que `resetAt` de la sala muerta se borra: la
  // barrera nueva es estrictamente más fuerte, y ese resetAt era estado de una sala
  // que ya no existe.
  forgetRoom(roomCode, at = Date.now()) {
    this.zones.delete(roomCode)
    this.detectedCells.delete(roomCode)
    this.lastDetectionAt.delete(roomCode)
    this.resetAt.delete(roomCode)
    this.deadAt.set(roomCode, at)
  }

  // Actividad del detector Spark para el tablero del admin, POR SALA (suma la
  // clave global). `total` = bloqueos distintos cazados en la corrida; `lastAgoMs`
  // = hace cuánto fue la última detección (null si todavía no hubo ninguna).
  detectionStatsFor(roomCode) {
    const cells = new Set()
    let last = 0
    for (const key of [roomCode, GLOBAL_ROOM_KEY]) {
      if (key == null) continue
      const s = this.detectedCells.get(key)
      if (s) for (const z of s) cells.add(z)
      const t = this.lastDetectionAt.get(key)
      if (t && t > last) last = t
    }
    return { total: cells.size, lastAgoMs: last ? Date.now() - last : null }
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

  // Vista global: unión de zonas activas de TODAS las salas (poda las expiradas).
  // El tick NO la usa — usa activeZonesFor(room.code), porque mezclar salas pintaría
  // en una la congestión de otra.
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

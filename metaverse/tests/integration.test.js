// Tests de la integración Kafka del metaverso (bun test — sin Kafka ni Spark).
// Blindan las propiedades load-bearing que las revisiones marcaron como riesgo:
//  · velocidad MEDIDA (un avatar detenido DEBE reportar ~0, o Spark queda ciego),
//  · mapeo coord→zona (grilla anclada a mitad de manzana),
//  · RedPointStore: un renombre de campo de Spark NO debe pasar en silencio.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { measuredSpeedMps } from '../server/speed.js'
import { GRID_COLS, GRID_ROWS, zoneIndexAt } from '../server/zoneGrid.js'
import { RedPointStore } from '../analytics/redPoints.js'
import { AnalyticsConsumer } from '../analytics/consumer.js'
import { RoomManager } from '../server/rooms.js'
import { KafkaBridge, SIM_EVENTS_TOPIC } from '../server/kafkaProducer.js'
import { ZoneSystem } from '../src/analytics/zones.js'
import { createEdgeState } from '../src/graph/mapData.js'
import { kafka } from '../src/kafka/producer.js'

// El producer simulado hace console.debug de cada evento; se silencia igual
// que en server/index.js (los tests inspeccionan kafka.log, no la consola).
console.debug = () => {}

const UNIT_TO_METERS = 4
const LAST_CELL = GRID_COLS * GRID_ROWS - 1 // 207

describe('measuredSpeedMps (propiedad crítica de la tesis)', () => {
  test('sin desplazamiento → 0 m/s (auto encolado / detenido)', () => {
    expect(measuredSpeedMps(0, 0, 1, UNIT_TO_METERS)).toBe(0)
  })

  test('en movimiento → m/s medidos desde el desplazamiento', () => {
    expect(measuredSpeedMps(3, 0, 1, UNIT_TO_METERS)).toBeCloseTo(12, 5) // 3u/s × 4
    expect(measuredSpeedMps(0, 3, 1, UNIT_TO_METERS)).toBeCloseTo(12, 5)
    expect(measuredSpeedMps(3, 4, 1, UNIT_TO_METERS)).toBeCloseTo(20, 5) // hypot(3,4)=5 × 4
  })

  test('un avatar casi inmóvil queda bajo el umbral 0.5 m/s del detector', () => {
    expect(measuredSpeedMps(0.02, 0, 1, UNIT_TO_METERS)).toBeLessThan(0.5)
  })

  test('un dt diminuto se clampa (sin división por cero)', () => {
    expect(Number.isFinite(measuredSpeedMps(1, 0, 0, UNIT_TO_METERS))).toBe(true)
  })
})

describe('zoneIndexAt (coords de mundo → celda del overlay, grilla a mitad de manzana)', () => {
  test('la grilla es 16×13', () => {
    expect(GRID_COLS).toBe(16)
    expect(GRID_ROWS).toBe(13)
  })

  test('las esquinas del mapa mapean a la primera y última celda', () => {
    expect(zoneIndexAt(-225, -180)).toBe(0)
    expect(zoneIndexAt(224, 179)).toBe(LAST_CELL)
  })

  test('coords fuera de rango se clampan, nunca lanzan', () => {
    expect(zoneIndexAt(-99999, -99999)).toBe(0)
    expect(zoneIndexAt(99999, 99999)).toBe(LAST_CELL)
  })

  test('siempre devuelve un entero en [0, LAST_CELL]', () => {
    for (const [x, z] of [[0, 0], [100, -50], [-200, 150]]) {
      const zone = zoneIndexAt(x, z)
      expect(Number.isInteger(zone)).toBe(true)
      expect(zone).toBeGreaterThanOrEqual(0)
      expect(zone).toBeLessThanOrEqual(LAST_CELL)
    }
  })

  // La propiedad que motivó la grilla: los bordes de celda caen a MITAD de
  // manzana, nunca sobre una vía. Los dos carriles de una cola (offset ±
  // respecto del eje de la vía) deben caer SIEMPRE en la misma celda; con la
  // grilla vieja (bordes sobre las calles) se partían entre dos zonas.
  test('los dos carriles de cada vía caen en la misma celda', () => {
    const LANE = 3   // mayor que el offset de carril real
    for (let z = -180; z <= 180; z += 30) {        // eje de cada calle
      for (let x = -220; x <= 220; x += 10) {
        expect(zoneIndexAt(x, z - LANE)).toBe(zoneIndexAt(x, z + LANE))
      }
    }
    for (let x = -225; x <= 225; x += 30) {        // eje de cada carrera
      for (let z = -175; z <= 175; z += 10) {
        expect(zoneIndexAt(x - LANE, z)).toBe(zoneIndexAt(x + LANE, z))
      }
    }
  })

  test('cada intersección vive centrada en su celda con sus 4 medias calles', () => {
    // Con celdas de 30 (1 cuadra) la unidad ya no es la manzana sino la
    // INTERSECCIÓN: todo punto a menos de media cuadra de una esquina cae en
    // la celda de esa esquina. Intersección Cra25 × Cl52: (-105, -30).
    const cell = zoneIndexAt(-105, -30)
    expect(zoneIndexAt(-105 - 14, -30)).toBe(cell)   // media calle al oeste
    expect(zoneIndexAt(-105 + 14, -30)).toBe(cell)   // media calle al este
    expect(zoneIndexAt(-105, -30 - 14)).toBe(cell)   // media calle al norte
    expect(zoneIndexAt(-105, -30 + 14)).toBe(cell)   // media calle al sur
    // Y las intersecciones vecinas (a 1 cuadra) caen en celdas DISTINTAS.
    expect(zoneIndexAt(-75, -30)).not.toBe(cell)
    expect(zoneIndexAt(-105, 0)).not.toBe(cell)
  })
})

describe('RedPointStore (red-points de Spark → zonas activas por sala)', () => {
  const fakeBridge = () => ({ mode: 'local', emitter: new EventEmitter() })
  const sparkRedPoint = (cx, cy, room) => ({
    room,
    cell_x: 1, cell_y: 1, center_x: cx, center_y: cy,
    stationary_avatars: 7,
    window_start: '2026-07-07 12:00:00', window_end: '2026-07-07 12:01:00',
  })

  test('un red-point bien formado activa su zona en su sala', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
  })

  test('las zonas son POR sala: otra sala no ve las de una sala ajena', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    expect(store.activeZonesFor('ECCI-9999')).toHaveLength(0)
  })

  test('un red-point sin sala cae en GLOBAL y lo ven todas las salas', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0)) // sin room
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
    expect(store.activeZonesFor('ECCI-9999')).toContain(zoneIndexAt(0, 0))
  })

  test('un campo center renombrado NO produce zona (guarda contra renombre silencioso)', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest({ room: 'ECCI-1234', cell_x: 1, cell_y: 1, centerX: 0, centerY: 0, stationary_avatars: 7 })
    expect(store.activeZonesFor('ECCI-1234')).toHaveLength(0)
  })

  test('una zona expirada se poda de activeZonesFor y del mapa de la sala', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    const zone = zoneIndexAt(0, 0)
    store.zones.get('ECCI-1234').set(zone, Date.now() - 1) // forzar expiración
    expect(store.activeZonesFor('ECCI-1234')).not.toContain(zone)
    expect(store.zones.has('ECCI-1234')).toBe(false) // sala sin zonas vivas → se descarta
  })

  // Red-point con bordes de ventana explícitos (UTC), para probar las barreras.
  // `windowStart` importa para la barrera de sala muerta (mira el arranque), y por
  // default queda muy atrás para no interferir con los tests del filtro de reset.
  const sparkRedPointAt = (room, windowEnd, windowStart = '2026-07-07 12:00:00') => ({
    room, cell_x: 1, cell_y: 1, center_x: 0, center_y: 0,
    stationary_avatars: 7, window_start: windowStart, window_end: windowEnd,
  })

  test('markReset limpia las zonas vivas de la sala (y solo de esa sala)', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    store._ingest(sparkRedPoint(0, 0, 'ECCI-9999'))
    store.markReset('ECCI-1234')
    expect(store.zones.has('ECCI-1234')).toBe(false)
    expect(store.activeZonesFor('ECCI-9999')).toContain(zoneIndexAt(0, 0)) // la otra sala intacta
  })

  test('tras reset, un red-point de una ventana cerrada ANTES del reset se descarta', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store.markReset('ECCI-1234', Date.parse('2026-07-07T12:05:00Z'))
    store._ingest(sparkRedPointAt('ECCI-1234', '2026-07-07 12:04:30')) // ventana previa al reset
    expect(store.activeZonesFor('ECCI-1234')).toHaveLength(0)
  })

  test('tras reset, una detección NUEVA (ventana posterior) sí activa su zona', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store.markReset('ECCI-1234', Date.parse('2026-07-07T12:05:00Z'))
    store._ingest(sparkRedPointAt('ECCI-1234', '2026-07-07 12:05:30')) // ventana posterior al reset
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
  })

  test('el reset es por sala: no descarta red-points de otra sala', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store.markReset('ECCI-1234', Date.parse('2026-07-07T12:05:00Z'))
    store._ingest(sparkRedPointAt('ECCI-9999', '2026-07-07 12:04:30')) // vieja, pero de OTRA sala
    expect(store.activeZonesFor('ECCI-9999')).toContain(zoneIndexAt(0, 0))
  })

  test('window_end ilegible no descarta (fail-open: mejor un fantasma que perder detecciones)', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store.markReset('ECCI-1234', Date.now())
    store._ingest(sparkRedPointAt('ECCI-1234', 'no-es-fecha'))
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
  })

  // Actividad del detector para el tablero: bloqueos DISTINTOS cazados y cuándo
  // fue el último. Es lo que el metaverso no puede medirse solo.
  test('detectionStatsFor cuenta celdas distintas, no re-emisiones', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))     // Spark re-emite la misma celda por slide
    store._ingest(sparkRedPoint(60, 60, 'ECCI-1234'))   // otra celda: ese sí es otro bloqueo
    const st = store.detectionStatsFor('ECCI-1234')
    expect(st.total).toBe(2)
    expect(st.lastAgoMs).toBeGreaterThanOrEqual(0)
  })

  test('sin detecciones, detectionStatsFor no miente: total 0 y sin última', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    expect(store.detectionStatsFor('ECCI-1234')).toEqual({ total: 0, lastAgoMs: null })
  })

  test('el reset del admin borra los contadores del detector de esa sala', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    store.markReset('ECCI-1234')
    expect(store.detectionStatsFor('ECCI-1234')).toEqual({ total: 0, lastAgoMs: null })
  })

  // LA regresión: el código de sala se RECICLA (RoomManager.create solo evita los
  // de las salas vivas). Sin forgetRoom, la sala nueva que caiga en un código
  // reusado hereda los contadores del detector de la sesión muerta anterior: el
  // tablero le mostraría al jurado bloqueos que nadie detectó en esta corrida.
  test('una sala destruida no le hereda sus detecciones a la que recicle su código', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    expect(store.detectionStatsFor('ECCI-1234').total).toBe(1)   // la sala vieja detectó

    store.forgetRoom('ECCI-1234')                                 // el barrido la destruyó

    // Misma sala nueva, mismo código: arranca en cero, no hereda nada.
    expect(store.detectionStatsFor('ECCI-1234')).toEqual({ total: 0, lastAgoMs: null })
    expect(store.activeZonesFor('ECCI-1234')).toHaveLength(0)
  })

  test('forgetRoom es por sala: no toca a las demás', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    store._ingest(sparkRedPoint(0, 0, 'ECCI-9999'))
    store.forgetRoom('ECCI-1234')
    expect(store.detectionStatsFor('ECCI-9999').total).toBe(1)
    expect(store.activeZonesFor('ECCI-9999')).toContain(zoneIndexAt(0, 0))
  })

  // Olvidar la sala no alcanza: Spark sigue emitiendo las ventanas que la sala
  // muerta dejó abiertas (~ventana+watermark ≈ 60s con los defaults, del mismo
  // orden que el TTL de sala vacía) y el red-point trae el código PELADO, sin
  // epoch. Si el código se recicló, esos rezagados entrarían como detecciones de
  // la sala nueva. Por eso forgetRoom LEVANTA la barrera resetAt en vez de
  // borrarla: no es estado de la muerta, es un corte temporal.
  test('un red-point rezagado de la sala muerta no cuenta para la que recicló su código', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    const muerte = Date.parse('2026-07-07T12:05:00Z')
    store.forgetRoom('ECCI-1234', muerte)                            // el barrido la destruyó
    // Ventana ya CERRADA antes de la muerte: puro dato de la sala muerta.
    store._ingest(sparkRedPointAt('ECCI-1234', '2026-07-07 12:04:50', '2026-07-07 12:04:40'))
    expect(store.detectionStatsFor('ECCI-1234')).toEqual({ total: 0, lastAgoMs: null })
    expect(store.activeZonesFor('ECCI-1234')).toHaveLength(0)
  })

  // EL residuo que la review encontró en el primer arreglo: una ventana que estaba
  // ABIERTA cuando la sala murió cierra DESPUÉS, así que una barrera que mire el
  // cierre la deja pasar. Y su contenido es de la sala muerta: la muerta dejó de
  // producir en el instante de la muerte, y la nueva todavía no existía. Por eso
  // esta barrera mira el ARRANQUE.
  test('una ventana abierta al morir la sala tampoco cuenta: trae dato de la muerta', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    const muerte = Date.parse('2026-07-07T12:05:00Z')
    store.forgetRoom('ECCI-1234', muerte)
    // Arrancó ANTES de la muerte y cerró DESPUÉS: a caballo.
    store._ingest(sparkRedPointAt('ECCI-1234', '2026-07-07 12:05:05', '2026-07-07 12:04:35'))
    expect(store.detectionStatsFor('ECCI-1234')).toEqual({ total: 0, lastAgoMs: null })
    expect(store.activeZonesFor('ECCI-1234')).toHaveLength(0)
  })

  test('pero una detección NUEVA (ventana arrancada tras la muerte) sí cuenta', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    const muerte = Date.parse('2026-07-07T12:05:00Z')
    store.forgetRoom('ECCI-1234', muerte)
    // Arrancó DESPUÉS de la muerte: solo puede ser de la sala nueva.
    store._ingest(sparkRedPointAt('ECCI-1234', '2026-07-07 12:05:30', '2026-07-07 12:05:20'))
    expect(store.detectionStatsFor('ECCI-1234').total).toBe(1)
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
  })

  // La barrera de muerte no puede convertirse en una mordaza permanente: si no
  // parsea el arranque, se deja pasar (mismo fail-open que el filtro de reset).
  test('window_start ilegible no descarta (fail-open, igual que el filtro de reset)', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store.forgetRoom('ECCI-1234', Date.now())
    store._ingest(sparkRedPointAt('ECCI-1234', '2026-07-07 12:05:30', 'no-es-fecha'))
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
  })
})

describe('KafkaBridge (topics internos consolidados en sim-events)', () => {
  // Event Hubs Standard permite 10 hubs por namespace; los 11 topics internos
  // viajan en sim-events con el topic lógico adentro del mensaje (3 físicos).
  const kafkaModeBridge = () => {
    const bridge = new KafkaBridge()
    bridge.mode = 'kafka'
    bridge.sent = []
    bridge.producer = { send: async m => { bridge.sent.push(m); return m } }
    return bridge
  }

  test('un topic interno viaja en sim-events con su topic lógico en el mensaje', () => {
    const bridge = kafkaModeBridge()
    bridge.setContext('ECCI-1234')
    bridge.publish('zone.red', { zone: 5, C: 0.7 })
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].topic).toBe(SIM_EVENTS_TOPIC)
    const value = JSON.parse(bridge.sent[0].messages[0].value)
    expect(value.topic).toBe('zone.red')
    expect(value.zone).toBe(5)
    expect(value.room).toBe('ECCI-1234')
  })

  test('los topics del contrato Spark viajan tal cual, sin envelope', () => {
    const bridge = kafkaModeBridge()
    bridge.setContext('ECCI-1234')
    bridge.publishBatch('avatar-positions', [{ avatar_id: 'a-1', x: 0, y: 0, speed: 0, ts: 'T' }])
    expect(bridge.sent[0].topic).toBe('avatar-positions')
    expect(JSON.parse(bridge.sent[0].messages[0].value).topic).toBeUndefined()
  })

  test('en modo local el bus en-proceso entrega el topic lógico como siempre', () => {
    const bridge = new KafkaBridge()   // mode 'local' por defecto
    const seen = []
    bridge.emitter.on('event', e => seen.push(e))
    bridge.setContext('ECCI-1234')
    bridge.publish('zone.red', { zone: 5 })
    expect(seen[0].topic).toBe('zone.red')
    expect(seen[0].event.zone).toBe(5)
  })

  test('el consumidor desenvuelve sim-events hacia la ingesta por topic lógico', () => {
    const c = new AnalyticsConsumer({ bridge: { mode: 'local', emitter: new EventEmitter() } })
    // Simula el eachMessage del modo kafka: mensaje de sim-events con envelope
    const wire = JSON.stringify({ topic: 'route.decision', room: 'ECCI-1234', userId: 1, choice: 'alternative', ahorro_estimado_s: 9 })
    const e = JSON.parse(wire)
    c._ingest(e.topic, e)
    expect(c.metricsForUser('ECCI-1234', 1).decisions.alternative).toBe(1)
  })
})

describe('ZoneSystem metricsOnly (telemetría del dashboard sin tocar el grafo)', () => {
  const fakeScene = { add() {}, remove() {} }

  // 25 avatares detenidos en la intersección (-105,-30): supera ZONE_RED_AVATARS
  // (20) y su C cruza el umbral — condición de zona roja garantizada.
  const CONGESTED = { x: -105, z: -30 }
  const N = 25

  function fakeAgents() {
    const calls = { reroutes: 0, invalidations: 0, checkerSet: 0 }
    return {
      calls,
      total: N,
      active: new Uint8Array(N).fill(1),
      state: new Uint8Array(N),                    // 0 = MOVING (no ARRIVED)
      posX: new Float32Array(N).fill(CONGESTED.x),
      posZ: new Float32Array(N).fill(CONGESTED.z),
      speed: new Float32Array(N),                  // 0 → déficit de velocidad total
      arrivedCount: 0,
      setRedZoneChecker() { calls.checkerSet++ },
      invalidateRoutesThroughZone() { calls.invalidations++ },
      rerouteAgentsThroughZone() { calls.reroutes++ },
      getStats: () => ({ active: N, stuck: 0, avgSpeedMps: 0 }),
    }
  }

  const build = metricsOnly => {
    const agents = fakeAgents()
    const state = createEdgeState()
    const zs = new ZoneSystem(fakeScene, {
      agentSystem: agents, incidentManager: { active: [] },
      headless: true, metricsOnly, graphState: state,
    })
    return { zs, agents, state }
  }

  test('calcula C y emite analytics.snapshot, pero NUNCA penaliza ni rerutea', () => {
    const { zs, agents, state } = build(true)
    const logBefore = kafka.log.length
    zs._recompute(1)

    const zone = zs.zoneIndexAt(CONGESTED.x, CONGESTED.z)
    expect(zs.isRed[zone]).toBe(1)                    // la bandera informativa sí se calcula
    expect(state.penalty.size).toBe(0)                // el grafo queda intacto
    expect(agents.calls.reroutes).toBe(0)
    expect(agents.calls.invalidations).toBe(0)
    expect(agents.calls.checkerSet).toBe(0)           // no pisa el checker de Spark

    const emitted = kafka.log.slice(logBefore)
    const snapshot = emitted.find(e => e.topic === 'analytics.snapshot')
    expect(snapshot).toBeDefined()
    expect(snapshot.zones_C[zone]).toBeGreaterThan(0) // el heatmap recibe C real
    expect(emitted.some(e => e.topic === 'zone.red')).toBe(false)
  })

  test('control: el modo normal SÍ penaliza y emite zone.red (el flag hace la diferencia)', () => {
    const { zs, agents, state } = build(false)
    const logBefore = kafka.log.length
    zs._recompute(1)

    expect(state.penalty.size).toBeGreaterThan(0)
    expect(agents.calls.reroutes).toBe(1)
    expect(agents.calls.checkerSet).toBe(1)
    expect(kafka.log.slice(logBefore).some(e => e.topic === 'zone.red')).toBe(true)
  })

  test('dispose() en metricsOnly no borra las penalizaciones de Spark del estado compartido', () => {
    const { zs, state } = build(true)
    zs._recompute(1)                                  // deja isRed=1 en la zona congestionada
    state.penalty.set('spark-edge', 500)              // penalización puesta por applySparkRedZones
    zs.dispose()
    expect(state.penalty.get('spark-edge')).toBe(500)
  })
})

// El cableado que lleva la limpieza a través del límite de módulo. Los tests de
// forgetRoom prueban cada store por separado; ESTE prueba el contrato que los une:
// que sweep() DEVUELVA los códigos que destruyó. Sin él, un refactor que se coma el
// return dejaría toda la suite en verde mientras el bug de reciclado vuelve.
describe('RoomManager.sweep (el contrato que dispara la limpieza por sala)', () => {
  test('devuelve los códigos que destruyó, para que quien tenga estado por sala lo olvide', () => {
    const rm = new RoomManager()
    const room = rm.create()
    expect(rm.sweep()).toEqual([])                      // recién creada: nadie la barre

    room.emptySince = Date.now() - 61_000               // vacía hace más del TTL
    expect(rm.sweep()).toEqual([room.code])             // la barre Y dice cuál era
    expect(rm.get(room.code)).toBeFalsy()               // y ya no existe
  })

  test('una sala con gente no se barre ni se reporta', () => {
    const rm = new RoomManager()
    const room = rm.create()
    room.joinAdmin({}, 'admin')                          // hay alguien → emptySince null
    room.emptySince = null
    expect(rm.sweep()).toEqual([])
    expect(rm.get(room.code)).toBeTruthy()
  })
})

describe('AnalyticsConsumer (zonas rojas del dashboard = detector Spark, no el índice C)', () => {
  const consumer = () => new AnalyticsConsumer({ bridge: { mode: 'local', emitter: new EventEmitter() } })

  test('noteSparkRedZones fija el conteo que reporta metricsForAdmin', () => {
    const c = consumer()
    c._ingest('agent.position', { room: 'ECCI-1234', avg_speed_mps: 3, stuck: 0, moving: 1, waiting: 0, arrived: 0 })
    c.noteSparkRedZones('ECCI-1234', 3)
    expect(c.metricsForAdmin('ECCI-1234').global.redZones).toBe(3)
  })

  // El código de sala se recicla (RoomManager.create solo evita los de las VIVAS):
  // sin olvidar, la sala nueva hereda las series y el desglose de la muerta.
  test('una sala destruida no le hereda su analítica a la que recicle su código', () => {
    const c = consumer()
    c._ingest('agent.position', { room: 'ECCI-1234', avg_speed_mps: 3, stuck: 0, moving: 5, waiting: 0, arrived: 7 })
    expect(c.metricsForAdmin('ECCI-1234').global.arrived).toBe(7)   // la vieja acumuló

    c.forgetRoom('ECCI-1234')                                        // el barrido la destruyó

    // Sala nueva con el mismo código: sin estado previo. metricsForAdmin devuelve
    // null porque la sala nueva todavía no produjo ni un evento.
    expect(c.metricsForAdmin('ECCI-1234')).toBeNull()
  })

  test('forgetRoom es por sala: no toca la analítica de las demás', () => {
    const c = consumer()
    for (const room of ['ECCI-1234', 'ECCI-9999']) {
      c._ingest('agent.position', { room, avg_speed_mps: 3, stuck: 0, moving: 1, waiting: 0, arrived: 4 })
    }
    c.forgetRoom('ECCI-1234')
    expect(c.metricsForAdmin('ECCI-9999').global.arrived).toBe(4)
  })

  test('analytics.snapshot alimenta C̄ y el heatmap pero NO pisa el conteo de Spark', () => {
    const c = consumer()
    c.noteSparkRedZones('ECCI-1234', 2)
    c._ingest('analytics.snapshot', {
      room: 'ECCI-1234', avg_C: 0.42, red_zones: 99,
      zones_C: [0.1, 0.9], zones_red: [0, 1],
    })
    const m = c.metricsForAdmin('ECCI-1234')
    expect(m.global.avgC).toBe(0.42)                  // C̄ vuelve a estar vivo
    expect(m.zones.C).toEqual([0.1, 0.9])             // gradiente del heatmap vivo
    expect(m.global.redZones).toBe(2)                 // Spark manda, no red_zones interno
  })

  test('la serie roja del sparkline sale del conteo Spark', () => {
    const c = consumer()
    c.noteSparkRedZones('ECCI-1234', 4)
    c._closeWindows()
    expect(c.metricsForAdmin('ECCI-1234').series.red.at(-1)).toBe(4)
  })
})

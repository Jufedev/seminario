// ════════════════════════════════════════════════════════════════
//  CONSUMIDOR ANALÍTICO (M5) — lee los topics de Kafka y agrega por
//  VENTANAS de ~1s, separado por sala. Expone las métricas que el
//  servidor manda a cada cliente según su rol:
//   · metricsForUser(room, slot)  → your_analytics (nivel USUARIO)
//   · metricsForAdmin(room)       → admin_analytics (nivel ADMIN)
//  Si el broker no está disponible, se suscribe al bus en-proceso del
//  KafkaBridge (mismos eventos, misma agregación — cero cambios aquí).
// ════════════════════════════════════════════════════════════════
import { Kafka, logLevel } from 'kafkajs'
import { TOPICS } from '../server/kafkaProducer.js'
import { kafkaConfig, kafkaBrokers } from '../server/kafkaConfig.js'
import { CALLES, CARRERAS, MAP_BOUNDS } from '../src/graph/mapData.js'
import { ANALYTICS_CONFIG as CFG } from '../src/analytics/config.js'

const PERSONAL_OFFSET = 100
const MAX_SAMPLES = 120     // ~2 min de series a 1 muestra/s
const r1 = v => Math.round(v * 10) / 10
const r2 = v => Math.round(v * 100) / 100

// Estado agregado de un usuario dentro de una sala
function newUser() {
  return {
    spawned: 0, arrived: 0, travelSum: 0, distSum: 0,          // flota
    personalTrips: 0, personalTravelSum: 0,                     // vehículo personal
    decisions: { keep: 0, alternative: 0, timeout: 0 },
    savings_s: 0,
    reroutes: 0,
    optimal_m: null,                                            // ruta óptima sin tráfico
  }
}

function newRoomState() {
  const nZones = CFG.GRID_SIZE * CFG.GRID_SIZE
  return {
    users: new Map(),                        // slot → newUser()
    incidentsByType: {}, incidentsActive: new Set(), incidentsTotal: 0,
    global: { active: 0, stuck: 0, avgSpeed: 0, avgC: 0, redZones: 0, arrived: 0 },
    zonesC: new Array(nZones).fill(0),       // último C por zona (heatmap)
    zonesRed: new Array(nZones).fill(0),
    zonesCSum: new Float64Array(nZones),     // acumulado de sesión → zona crítica
    zonesSamples: 0,
    window: { arrivals: 0, decisions: 0, incidents: 0 },   // contadores de la ventana actual
    series: { t: [], speed: [], red: [], incidents: [], arrivals: [] },
    startedAt: Date.now(),
  }
}

export class AnalyticsConsumer {
  constructor({ bridge }) {
    this.brokers = kafkaBrokers()   // KAFKA_BOOTSTRAP / Event Hubs / localhost:9092
    this.bridge = bridge
    this.rooms = new Map()     // roomCode → estado agregado
    this.mode = 'local'
    this.consumed = 0
  }

  async start() {
    // Preferir Kafka real; si el bridge quedó en local, escuchar el bus en-proceso
    if (this.bridge.mode === 'kafka') {
      try {
        const client = new Kafka({ ...kafkaConfig('ecci-analytics'), logLevel: logLevel.NOTHING })
        this.consumer = client.consumer({ groupId: 'ecci-analytics' })
        // Un fallo del broker DESPUÉS del arranque dispara CRASH; sin este listener
        // el consumidor moriría en silencio y la analítica dejaría de agregar sin señal.
        this.consumer.on(this.consumer.events.CRASH, e =>
          console.error('[analytics] CRASH del consumidor Kafka:', e.payload?.error?.message ?? e.payload?.error, '— la analítica puede quedar detenida'))
        await this.consumer.connect()
        for (const topic of TOPICS) await this.consumer.subscribe({ topic })
        await this.consumer.run({
          eachMessage: async ({ topic, message }) => {
            try { this._ingest(topic, JSON.parse(message.value.toString())) } catch { /* evento corrupto */ }
          },
        })
        this.mode = 'kafka'
        console.log('[analytics] consumidor Kafka activo (groupId ecci-analytics)')
      } catch (err) {
        console.error('[analytics] consumidor Kafka falló, usando bus local:', err.message)
        // coherencia: si el consumidor no puede leer del broker, el productor también
        // baja a modo local — si no, los eventos irían a Kafka y nadie los agregaría
        this.bridge.mode = 'local'
        this._attachLocal()
      }
    } else {
      this._attachLocal()
    }
    // Cierre de ventana cada ~1s: consolida los contadores en las series de tiempo
    this._windowTimer = setInterval(() => this._closeWindows(), 1000)
  }

  _attachLocal() {
    this.mode = 'local'
    this.bridge.emitter.on('event', ({ topic, event }) => this._ingest(topic, event))
    console.log('[analytics] consumidor en modo local (bus en-proceso)')
  }

  _room(code) {
    if (!code) return null
    let st = this.rooms.get(code)
    if (!st) { st = newRoomState(); this.rooms.set(code, st) }
    return st
  }
  _user(st, slotRaw) {
    const slot = slotRaw >= PERSONAL_OFFSET ? slotRaw - PERSONAL_OFFSET : slotRaw
    let u = st.users.get(slot)
    if (!u) { u = newUser(); st.users.set(slot, u) }
    return { u, personal: slotRaw >= PERSONAL_OFFSET }
  }

  // ── Ingesta: un evento de un topic → acumuladores de su sala ──
  _ingest(topic, e) {
    this.consumed++
    const st = this._room(e.room)
    if (!st) return

    switch (topic) {
      case 'agent.spawn': {
        if (e.owner == null || e.owner < 0) break
        const { u, personal } = this._user(st, e.owner)
        if (!personal) u.spawned++
        break
      }
      case 'agent.arrived': {
        if (e.owner == null || e.owner < 0) break
        const { u, personal } = this._user(st, e.owner)
        if (personal) { u.personalTrips++; u.personalTravelSum += e.travel_time_s }
        else { u.arrived++; u.travelSum += e.travel_time_s; u.distSum += e.distance_m }
        st.window.arrivals++
        break
      }
      case 'agent.reroute': {
        if (e.owner != null && e.owner >= 0) this._user(st, e.owner).u.reroutes++
        break
      }
      case 'agent.position':
        st.global.avgSpeed = e.avg_speed_mps
        st.global.stuck = e.stuck
        st.global.active = e.moving + e.waiting + e.stuck
        st.global.arrived = e.arrived
        break
      case 'route.decision': {
        const { u } = this._user(st, e.userId)
        if (e.source === 'timeout') u.decisions.timeout++
        else u.decisions[e.choice === 'alternative' ? 'alternative' : 'keep']++
        if (e.choice === 'alternative') u.savings_s += Math.max(0, e.ahorro_estimado_s)
        st.window.decisions++
        break
      }
      case 'incident.start':
        st.incidentsByType[e.type] = (st.incidentsByType[e.type] || 0) + 1
        st.incidentsActive.add(e.incident_id)
        st.incidentsTotal++
        st.window.incidents++
        break
      case 'incident.end':
        st.incidentsActive.delete(e.incident_id)
        break
      case 'analytics.snapshot':
        st.global.avgC = e.avg_C
        st.global.redZones = e.red_zones
        if (e.zones_C) {
          st.zonesC = e.zones_C
          st.zonesRed = e.zones_red
          for (let i = 0; i < e.zones_C.length; i++) st.zonesCSum[i] += e.zones_C[i]
          st.zonesSamples++
        }
        break
      case 'room.lifecycle':
        if (e.action === 'set_route' && e.userId != null) this._user(st, e.userId).u.optimal_m = e.optimal_m
        // reset del admin → analítica fresca para la corrida nueva (rutas se conservan)
        if (e.action === 'control' && e.value === 'reset') {
          const routes = new Map([...st.users].map(([slot, u]) => [slot, u.optimal_m]))
          const fresh = newRoomState()
          for (const [slot, opt] of routes) { const u = newUser(); u.optimal_m = opt; fresh.users.set(slot, u) }
          this.rooms.set(e.room, fresh)
        }
        break
      // zone.red / zone.clear quedan registrados en Kafka; el estado por zona
      // ya llega consolidado en analytics.snapshot (zones_C / zones_red)
    }
  }

  // ── Cierre de ventana (~1s): consolida contadores → series de tiempo ──
  _closeWindows() {
    for (const st of this.rooms.values()) {
      const s = st.series
      s.t.push(Math.round((Date.now() - st.startedAt) / 1000))
      s.speed.push(r1(st.global.avgSpeed))
      s.red.push(st.global.redZones)
      s.incidents.push(st.incidentsActive.size)
      s.arrivals.push(st.window.arrivals)
      if (s.t.length > MAX_SAMPLES) for (const k in s) s[k].shift()
      st.window = { arrivals: 0, decisions: 0, incidents: 0 }
    }
  }

  // ── Nivel USUARIO: your_analytics ──
  metricsForUser(room, slot) {
    const st = this.rooms.get(room)
    const u = st?.users.get(slot)
    if (!u) return null
    const avgDist = u.arrived ? u.distSum / u.arrived : null
    return {
      fleet: {
        spawned: u.spawned, arrived: u.arrived, active: Math.max(0, u.spawned - u.arrived),
        avgTravel_s: u.arrived ? r1(u.travelSum / u.arrived) : null,
      },
      personal: {
        trips: u.personalTrips,
        avgTravel_s: u.personalTrips ? r1(u.personalTravelSum / u.personalTrips) : null,
      },
      decisions: { ...u.decisions },
      savings_s: r1(u.savings_s),
      efficiency: u.optimal_m && avgDist ? r2(u.optimal_m / avgDist) : null,
      reroutes: u.reroutes,
    }
  }

  // ── Nivel ADMIN: admin_analytics (global + desglose por usuario + zonas + series) ──
  metricsForAdmin(room) {
    const st = this.rooms.get(room)
    if (!st) return null
    const perUser = []
    for (const [slot, u] of [...st.users].sort((a, b) => a[0] - b[0])) {
      const m = this.metricsForUser(room, slot)
      perUser.push({ slot, ...m })
    }
    // Rankings del desglose: mejor decisor, flota más rápida, quién sufre más congestión
    const withArrivals = perUser.filter(p => p.fleet.arrived > 0)
    const bestDecider = perUser.reduce((b, p) => (p.savings_s > (b?.savings_s ?? 0) ? p : b), null)
    const fastestFleet = withArrivals.reduce((b, p) => (!b || p.fleet.avgTravel_s < b.fleet.avgTravel_s ? p : b), null)
    const mostCongested = perUser.reduce((b, p) => (p.reroutes > (b?.reroutes ?? -1) ? p : b), null)

    // Zona más crítica de la sesión (C̄ acumulado) → cruce aproximado por nombres reales
    let critical = null
    if (st.zonesSamples > 0) {
      let best = 0
      for (let i = 1; i < st.zonesCSum.length; i++) if (st.zonesCSum[i] > st.zonesCSum[best]) best = i
      const G = CFG.GRID_SIZE
      const zx = best % G, zz = Math.floor(best / G)
      const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
      const cx = xMin + (zx + 0.5) * (xMax - xMin) / G
      const cz = zMin + (zz + 0.5) * (zMax - zMin) / G
      const cra = CARRERAS.reduce((b, c) => Math.abs(c.x - cx) < Math.abs(b.x - cx) ? c : b)
      const cl = CALLES.reduce((b, c) => Math.abs(c.z - cz) < Math.abs(b.z - cz) ? c : b)
      critical = { zone: best, zx, zz, avgC: r2(st.zonesCSum[best] / st.zonesSamples), label: `${cra.name} × ${cl.name}` }
    }

    return {
      global: {
        active: st.global.active, arrived: st.global.arrived, stuck: st.global.stuck,
        avgSpeed: r1(st.global.avgSpeed), avgC: r2(st.global.avgC), redZones: st.global.redZones,
        incidentsActive: st.incidentsActive.size, incidentsTotal: st.incidentsTotal,
        incidentsByType: { ...st.incidentsByType },
      },
      perUser,
      rankings: {
        bestDecider: bestDecider && bestDecider.savings_s > 0 ? bestDecider.slot : null,
        fastestFleet: fastestFleet?.slot ?? null,
        mostCongested: mostCongested && mostCongested.reroutes > 0 ? mostCongested.slot : null,
      },
      zones: { C: st.zonesC, red: st.zonesRed, grid: CFG.GRID_SIZE },
      critical,
      series: st.series,
      mode: this.mode,
    }
  }

  async dispose() {
    clearInterval(this._windowTimer)
    try { await this.consumer?.disconnect() } catch { /* cerrando */ }
  }
}

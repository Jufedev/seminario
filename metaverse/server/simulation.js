// ════════════════════════════════════════════════════════════════
//  SIMULACIÓN AUTORITATIVA (M4) — además de las flotas (M3), cada
//  usuario tiene UN VEHÍCULO PERSONAL (owner = slot + 100):
//  · Cuando un atasco/bloqueo aparece en SU ruta, el vehículo se PAUSA
//    (solo él: el resto del mundo sigue) y el servidor ofrece la
//    decisión de 5s: seguir (keep) o tomar la alternativa.
//  · Sin respuesta al vencer el deadline → 'keep'.
//  · Si el usuario no invoca su vehículo a tiempo → alerta al admin,
//    que puede invocarlo por él.
//  Las flotas conservan el auto-reroute automático de M3.
// ════════════════════════════════════════════════════════════════
import {
  POINTS, NODES, pointNode, allEdges, createEdgeState, resetGraph,
  dijkstra, isEdgeBlocked, pathLengthUnits, UNIT_TO_METERS, setEdgePenalty,
} from './graph.js'
import { TrafficSystem } from '../src/sim/traffic.js'
import { AgentSystem } from '../src/sim/agents.js'
import { IncidentManager } from '../src/sim/incidents.js'
import { ZoneSystem } from '../src/analytics/zones.js'
import { SIM_CONFIG } from '../src/sim/config.js'
import { kafka } from '../src/kafka/producer.js'
import { measuredSpeedMps } from './speed.js'

const fakeScene = { add() {}, remove() {} }   // el server no dibuja: solo estado

export const PERSONAL_OFFSET = 100   // owner del vehículo personal = slot + 100

const FLEET_DEFAULTS = { count: 20, spawnBatch: 5, spawnEvery: 2 }
const LIMITS = {
  count: [1, 150],        // por usuario (3×150 = 450 < 500 de capacidad total)
  spawnBatch: [1, 50],
  spawnEvery: [0.5, 10],
  incidentFreq: [3, 60],
}
const OFFER_MS = 5000          // ventana de decisión del usuario
const OFFER_COOLDOWN_MS = 15000 // tras decidir, no re-ofertar al mismo vehículo por un rato
const ALERT_AFTER_MS = 15000   // ruta configurada sin invocar el personal → alerta al admin

const POS_SAMPLE_S = 1         // cadencia del feed por-avatar hacia Spark (avatar-positions): ~1 Hz, NO 20 Hz
const SPARK_ZONE_PENALTY = 40  // penalización a Dijkstra por arista de una zona roja de Spark (~edge weight ⇒ se evita)

const clamp = (v, [lo, hi], fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const r2 = v => Math.round(v * 100) / 100
const r1 = v => Math.round(v * 10) / 10

export class Simulation {
  constructor(label = '') {
    this.label = label ? ` ${label}` : ''
    this.run = 1          // incrementa en cada reset (los clientes vacían su buffer al verlo cambiar)
    this.tick = 0
    this.time = 0
    this.running = true
    this.incidentFreq = 10

    this.graphState = createEdgeState()   // bloqueos/penalizaciones SOLO de esta sala
    this.traffic = new TrafficSystem(fakeScene)
    this.agents = new AgentSystem(fakeScene, { traffic: this.traffic, graphState: this.graphState })
    this.incidents = new IncidentManager(fakeScene, {
      agentSystem: this.agents, graphEdges: allEdges(),
      frequencySec: this.incidentFreq, headless: true, graphState: this.graphState,
    })
    // M5: la analítica de zonas 6×6 (índice C, zonas rojas) corre en el servidor
    this.zones = new ZoneSystem(fakeScene, {
      agentSystem: this.agents, incidentManager: this.incidents,
      headless: true, graphState: this.graphState,
    })
    this.routesByUser = new Map()   // slot → {origin, dest, optimal_m} (para sim_info y eficiencia)

    // ── Estado M4: ofertas, decisiones y alertas ──
    this.pendingOffers = new Map()      // slot → {slot, vehicleId, currentEta, altEta, deadline}
    this.offerCooldownUntil = new Map() // vehicleId → ms de pared (no re-ofertar enseguida)
    this.decisions = []                  // registro de decisiones (listo para Kafka en M5)
    this.outbox = []                     // mensajes dirigidos: {to: slot|'admin', msg}
    this.infoDirty = false               // sim_info cambió por un evento interno (timeout de oferta)
    this.routeSetAt = new Map()          // slot → ms en que configuró su ruta (para la alerta)
    this.alertSent = new Set()           // slots ya alertados
    this.personalInvoked = new Set()     // slots que ya invocaron su vehículo alguna vez
    this._alertAcc = 0

    // ── Feed por-avatar hacia el detector Spark (topic avatar-positions) ──
    // Velocidad MEDIDA por desplazamiento real (no la deseada speed[i]): un
    // avatar en fila reporta ~0 y el filtro speed<0.5 del detector lo ve.
    const N = SIM_CONFIG.MAX_AGENTS
    this._posAcc = 0
    this._lastEmitX = new Float32Array(N)
    this._lastEmitZ = new Float32Array(N)
    this._lastEmitTime = new Float64Array(N)
    this._emitSeen = new Uint8Array(N)   // 1 = ya hay una muestra previa para medir desplazamiento

    // ── Zonas rojas provenientes de SPARK (topic red-points) — fuente de verdad ──
    // Reemplazan a la detección interna de ZoneSystem para el overlay (rz) y el
    // reruteo. Índices de zona 6×6 + unión de sus node ids (para la caché de rutas).
    this._sparkRedZones = new Set()
    this._sparkRedNodeIds = new Set()

    // Los vehículos PERSONALES no auto-rerutean: se pausan y su dueño decide.
    this.agents.onRerouteIntercept = (i, motivo, a, b) => {
      const owner = this.agents.owner[i]
      if (owner < PERSONAL_OFFSET) return false   // flotas: comportamiento automático de M3
      this._tryCreateOffer(owner - PERSONAL_OFFSET, i, a, b)
      return true
    }

    // La caché de rutas evita las zonas rojas de SPARK (ya no las de ZoneSystem).
    this._installSparkRedChecker()
  }

  // El checker de la caché usa el conjunto de node ids rojos de Spark. Se
  // reinstala tras cada reset porque _reset() recrea el ZoneSystem, cuyo
  // constructor vuelve a registrar SU propio checker (que queda anulado).
  _installSparkRedChecker() {
    this.agents.setRedZoneChecker(path => path.some(id => this._sparkRedNodeIds.has(id)))
  }

  // ── Controles del usuario (slot 1..3) ──
  setUserRoute(slot, originPid, destPid) {
    const o = POINTS.find(p => p.id === originPid), d = POINTS.find(p => p.id === destPid)
    if (!o || !d || o.id === d.id) return false
    // Distancia óptima SIN tráfico (estado limpio): referencia del score de eficiencia
    const cleanPath = dijkstra(o.node, d.node, createEdgeState())
    const optimal_m = cleanPath ? Math.round(pathLengthUnits(cleanPath) * UNIT_TO_METERS) : null
    this.routesByUser.set(slot, { origin: o.id, dest: d.id, optimal_m })
    kafka.send('room.lifecycle', { action: 'set_route', userId: slot, origin: o.id, dest: d.id, optimal_m })
    const fleet = this.agents.fleets.get(slot)
    if (!fleet) this.agents.addFleet(slot, { originId: o.node, destId: d.node, ...this._fleetDefaults() })
    else this.agents.setFleetRoute(slot, o.node, d.node)
    // el vehículo personal (si existe) apunta a la ruta nueva en su próxima invocación
    if (this.agents.fleets.has(slot + PERSONAL_OFFSET)) this.agents.setFleetRoute(slot + PERSONAL_OFFSET, o.node, d.node)
    // arma la alerta "no ha invocado su vehículo" para este usuario
    if (!this.personalInvoked.has(slot)) { this.routeSetAt.set(slot, Date.now()); this.alertSent.delete(slot) }
    console.log(`[sim${this.label}] Usuario ${slot}: ruta ${o.id} → ${d.id}`)
    return true
  }

  setUserFleet(slot, { count, spawnBatch, spawnEvery }) {
    if (!this.agents.fleets.has(slot)) return false   // primero la ruta (crea la flota)
    this.agents.setFleetParams(slot, {
      count: clamp(count, LIMITS.count, FLEET_DEFAULTS.count),
      spawnBatch: clamp(spawnBatch, LIMITS.spawnBatch, FLEET_DEFAULTS.spawnBatch),
      spawnIntervalMs: clamp(spawnEvery, LIMITS.spawnEvery, FLEET_DEFAULTS.spawnEvery) * 1000,
    })
    return true
  }

  invokeFleet(slot) {
    const ok = this.agents.invokeFleet(slot)
    if (ok) {
      kafka.send('room.lifecycle', { action: 'invoke_fleet', userId: slot })
      console.log(`[sim${this.label}] Usuario ${slot} invocó su flota`)
    }
    return ok
  }

  // Invoca el VEHÍCULO PERSONAL del usuario (uno activo a la vez).
  // source: 'usuario' | 'admin' (el admin puede invocarlo tras la alerta)
  invokePersonal(slot, source = 'usuario') {
    const route = this.routesByUser.get(slot)
    if (!route) return false
    const owner = slot + PERSONAL_OFFSET
    const oNode = pointNode(route.origin), dNode = pointNode(route.dest)
    let fleet = this.agents.fleets.get(owner)
    if (!fleet) fleet = this.agents.addFleet(owner, { originId: oNode, destId: dNode, count: 1, spawnBatch: 1, spawnIntervalMs: 500, priority: true })
    else this.agents.setFleetRoute(owner, oNode, dNode)
    const enCamino = fleet.remaining + fleet.pending > 0 || fleet.spawned > fleet.arrived
    if (enCamino) return false             // ya hay un personal en la vía
    this.agents.invokeFleet(owner)
    this.personalInvoked.add(slot)
    this.alertSent.add(slot)               // ya no hay nada que alertar
    kafka.send('room.lifecycle', { action: 'invoke_personal', userId: slot, source })
    console.log(`[sim${this.label}] vehículo personal del Usuario ${slot} invocado${source === 'admin' ? ' POR EL ADMIN' : ''}`)
    return true
  }

  _fleetDefaults() {
    return {
      count: FLEET_DEFAULTS.count,
      spawnBatch: FLEET_DEFAULTS.spawnBatch,
      spawnIntervalMs: FLEET_DEFAULTS.spawnEvery * 1000,
    }
  }

  // ── Decisión de los 5 segundos ──
  // Crea la oferta para el vehículo personal `i` del usuario `slot` (si procede).
  _tryCreateOffer(slot, i, blockA, blockB) {
    if (this.pendingOffers.has(slot)) return                              // ya está decidiendo
    if ((this.offerCooldownUntil.get(i) ?? 0) > Date.now()) return        // decidió hace poco: sigue esperando
    const as = this.agents
    const path = as.pathNodes[i]
    if (!path) return
    const destNode = path[path.length - 1]
    const fromNode = path[as.segIndex[i] + 1] ?? path[as.segIndex[i]]
    const altTail = dijkstra(fromNode, destNode, this.graphState)
    if (!altTail || altTail.length < 2) return                            // sin alternativa: nada que decidir

    const speed = SIM_CONFIG.AGENT_SPEED * as.speedFactor[i]
    // ETA actual = terminar la ruta de siempre + esperar a que el bloqueo se libere
    const currentEta = as.remainingDistanceUnits(i) / speed + this._blockRemaining(i, blockA, blockB)
    // ETA alternativa = llegar al nodo de adelante + recorrer la ruta nueva
    const a0 = NODES[path[as.segIndex[i]]], b0 = NODES[fromNode]
    const toNode = Math.max(0, Math.hypot(a0.x - b0.x, a0.z - b0.z) - as.segDist[i])
    const altEta = (toNode + pathLengthUnits(altTail)) / speed

    const deadline = Date.now() + OFFER_MS
    this.pendingOffers.set(slot, { slot, vehicleId: i, currentEta, altEta, deadline })
    as.setPaused(i, true)   // SOLO este avatar se pausa; el resto del mundo sigue
    this.outbox.push({
      to: slot,
      msg: { type: 'route_offer', userId: slot, vehicleId: i, currentEta: r1(currentEta), altEta: r1(altEta), deadline },
    })
    console.log(`[sim${this.label}] oferta al Usuario ${slot} (veh ${i}): seguir ~${currentEta.toFixed(0)}s vs alterna ~${altEta.toFixed(0)}s`)
  }

  // Tiempo restante estimado del bloqueo que afecta la ruta del vehículo `i`
  _blockRemaining(i, blockA, blockB) {
    let edge = blockA && blockB ? { a: blockA, b: blockB } : null
    if (!edge) {
      const as = this.agents, path = as.pathNodes[i]
      for (let k = as.segIndex[i]; k < path.length - 1; k++) {
        if (isEdgeBlocked(path[k], path[k + 1], this.graphState)) { edge = { a: path[k], b: path[k + 1] }; break }
      }
    }
    if (edge) {
      const inc = this.incidents.active.find(x =>
        (x.edge.a === edge.a && x.edge.b === edge.b) || (x.edge.a === edge.b && x.edge.b === edge.a))
      if (inc) return Math.max(0, inc.start + inc.duration - this.time)
    }
    return 8   // sin incidente identificable (p.ej. atasco puro): espera nominal
  }

  // choice: 'keep' | 'alternative' · source: 'usuario' | 'timeout'
  resolveDecision(slot, vehicleId, choice, source = 'usuario') {
    const offer = this.pendingOffers.get(slot)
    if (!offer || offer.vehicleId !== vehicleId) return false
    this.pendingOffers.delete(slot)
    this.agents.setPaused(vehicleId, false)
    this.offerCooldownUntil.set(vehicleId, Date.now() + OFFER_COOLDOWN_MS)
    if (choice === 'alternative') this.agents.forceReroute(vehicleId, 'decision_usuario')

    // Registro de la decisión (dato clave del análisis; a Kafka real en M5)
    const entry = {
      userId: slot, vehicleId, choice, source,
      current_eta_s: r1(offer.currentEta), alt_eta_s: r1(offer.altEta),
      ahorro_estimado_s: r1(offer.currentEta - offer.altEta),
      ts: Date.now(),
    }
    this.decisions.push(entry)
    kafka.send('route.decision', entry)
    this.infoDirty = true   // el conteo de decisiones cambió → reenviar sim_info
    console.log(`[sim${this.label}] decisión del Usuario ${slot}: ${choice} (${source})`)
    return true
  }

  // Alerta al admin si un usuario configuró ruta pero nunca invocó su vehículo
  _checkInvokeAlerts() {
    for (const [slot, at] of this.routeSetAt) {
      if (this.personalInvoked.has(slot) || this.alertSent.has(slot)) continue
      if (Date.now() - at < ALERT_AFTER_MS) continue
      this.alertSent.add(slot)
      this.outbox.push({ to: 'admin', msg: { type: 'alert_admin', alert: 'vehicle_not_invoked', userId: slot } })
      console.log(`[sim${this.label}] ALERTA al admin: Usuario ${slot} no ha invocado su vehículo`)
    }
  }

  // Mensajes dirigidos pendientes (ofertas → usuario, alertas → admin); los envía index.js
  drainOutbox() {
    if (!this.outbox.length) return []
    const out = this.outbox
    this.outbox = []
    return out
  }

  // ── Controles del admin ──
  setIncidentFreq(freq) {
    this.incidentFreq = clamp(freq, LIMITS.incidentFreq, this.incidentFreq)
    this.incidents.setFrequency(this.incidentFreq)
    console.log(`[sim${this.label}] admin: incidentes cada ~${this.incidentFreq}s`)
  }

  control(action) {
    if (action === 'start') this.running = true
    else if (action === 'pause') this.running = false
    else if (action === 'reset') this._reset()
    else return false
    kafka.send('room.lifecycle', { action: 'control', value: action })
    console.log(`[sim${this.label}] admin: ${action}`)
    return true
  }

  // Reset: mundo vacío, sin incidentes ni ofertas, tiempo a cero. Las CONFIGURACIONES
  // de flota/ruta se conservan; las alertas de invocación se rearman.
  _reset() {
    this.agents.resetAgents()
    this.incidents.clearAll()
    resetGraph(this.graphState)
    // zonas frescas (historial de C̄ y banderas rojas a cero para la corrida nueva)
    this.zones.dispose()
    this.zones = new ZoneSystem(fakeScene, {
      agentSystem: this.agents, incidentManager: this.incidents,
      headless: true, graphState: this.graphState,
    })
    this.pendingOffers.clear()
    this.offerCooldownUntil.clear()
    this.personalInvoked.clear()
    this.alertSent.clear()
    for (const slot of this.routesByUser.keys()) this.routeSetAt.set(slot, Date.now())
    // Feed por-avatar y zonas rojas de Spark, frescos para la corrida nueva.
    // resetGraph() ya limpió las penalizaciones de las zonas rojas anteriores.
    this._posAcc = 0
    this._emitSeen.fill(0)
    this._sparkRedZones = new Set()
    this._sparkRedNodeIds = new Set()
    this._installSparkRedChecker()   // el ZoneSystem recién creado reregistró su checker: reinstalar el nuestro
    this.time = 0
    this.run++          // run nuevo → los clientes descartan snapshots viejos del buffer
    this.running = true
  }

  // Un tick de simulación (20 Hz). En pausa no avanza el mundo, pero las ofertas
  // caducan por reloj de pared igualmente (default 'keep').
  step(dt) {
    this.tick++
    for (const [slot, offer] of [...this.pendingOffers]) {
      if (Date.now() >= offer.deadline) resolveTimeout(this, slot, offer)
    }
    if (!this.running) return
    this.time += dt
    this.traffic.update(dt)
    this.agents.update(dt, this.time)
    this.incidents.update(dt, this.time)
    // DESCONECTADO: la detección interna de ZoneSystem (índice C → zona roja,
    // reruteo y penalizaciones, más su evento analytics.snapshot) queda
    // SUPERSEDIDA por el detector Big Data de Spark (topic red-points). El
    // código de ZoneSystem se conserva intacto y su geometría de zonas
    // (zoneEdges/zoneNodeIds) se reutiliza en applySparkRedZones(), pero su
    // bucle de detección ya NO se avanza: overlay (rz) y reruteo vienen de Spark.
    // this.zones.update(dt, this.time)
    this._alertAcc += dt
    if (this._alertAcc >= 1) { this._alertAcc = 0; this._checkInvokeAlerts() }
  }

  // ── Task 2: feed por-avatar hacia el detector Spark (topic avatar-positions) ──
  // Throttle a ~1 Hz (NO al 20 Hz del tick). index.js lo llama solo cuando la
  // sala corre. Produce UN mensaje por avatar ACTIVO (MOVING/WAITING/STUCK).
  maybeSampleAvatarPositions(dt, roomCode) {
    this._posAcc += dt
    if (this._posAcc < POS_SAMPLE_S) return
    this._posAcc -= POS_SAMPLE_S
    this._sampleAvatarPositions(roomCode)
  }

  _sampleAvatarPositions(roomCode) {
    const as = this.agents
    const now = Date.now()
    const iso = new Date().toISOString()
    const batch = []
    for (let i = 0; i < as.agentCount; i++) {
      if (!as.active[i]) continue
      if (as.state[i] === 3 /* ARRIVED */) continue   // solo MOVING/WAITING/STUCK
      const x = as.posX[i], z = as.posZ[i]
      let speedMps
      if (this._emitSeen[i]) {
        // velocidad MEDIDA: desplazamiento real entre emisiones (unidades→m sobre s de pared).
        // Un avatar detenido reporta ~0 aunque su speed[i] deseada sea la de crucero.
        speedMps = measuredSpeedMps(
          x - this._lastEmitX[i], z - this._lastEmitZ[i],
          (now - this._lastEmitTime[i]) / 1000, UNIT_TO_METERS,
        )
      } else {
        // primera muestra del avatar: sin desplazamiento previo, usa la deseada (unidades/s → m/s)
        speedMps = as.speed[i] * UNIT_TO_METERS
      }
      this._lastEmitX[i] = x
      this._lastEmitZ[i] = z
      this._lastEmitTime[i] = now
      this._emitSeen[i] = 1
      // Topic del contrato (con guion). El envelope del bridge añade room/ts,
      // pero el payload va ÚLTIMO → su ts ISO gana. avatar_id lleva la sala.
      batch.push({
        avatar_id: `${roomCode}-${i}`,
        x: r2(x),                  // three.js posX → x
        y: r2(z),                  // three.js posZ (plano de piso) → y
        speed: +speedMps.toFixed(3),
        ts: iso,
      })
    }
    // UN solo produce por sala por segundo, no uno por avatar (hasta ~500/sala/s).
    if (batch.length) kafka.sendBatch('avatar-positions', batch)
  }

  // ── Task 3: zonas rojas desde Spark (red-points) → overlay + reruteo ──
  // index.js pasa las zonas activas (con TTL) del RedPointStore cada tick.
  // Reutiliza la GEOMETRÍA de ZoneSystem (zoneEdges/zoneNodeIds: mapeo puro de
  // aristas/nodos→zona) para penalizar Dijkstra y desviar a quien entra, pero
  // la DECISIÓN de qué zona es roja la toma Spark, no la analítica interna.
  applySparkRedZones(zoneIndices) {
    const incoming = zoneIndices instanceof Set ? zoneIndices : new Set(zoneIndices)
    const newlyRed = []
    for (const z of incoming) if (!this._sparkRedZones.has(z)) newlyRed.push(z)
    const cleared = []
    for (const z of this._sparkRedZones) if (!incoming.has(z)) cleared.push(z)
    if (!newlyRed.length && !cleared.length) return   // sin cambios: nada que recalcular

    for (const z of newlyRed) setZoneEdgePenalty(this.zones.zoneEdges[z], SPARK_ZONE_PENALTY, this.graphState)
    for (const z of cleared) setZoneEdgePenalty(this.zones.zoneEdges[z], 0, this.graphState)
    this._sparkRedZones = incoming

    // Unión de node ids rojos → checker de la caché de rutas (evita revalidar rutas hacia la zona)
    const nodeIds = new Set()
    for (const z of incoming) for (const id of this.zones.zoneNodeIds[z]) nodeIds.add(id)
    this._sparkRedNodeIds = nodeIds

    // Solo en la transición a roja: invalidar caché y desviar a los que la cruzan
    for (const z of newlyRed) {
      this.agents.invalidateRoutesThroughZone(this.zones.zoneNodeIds[z])
      this.agents.rerouteAgentsThroughZone(this.zones.zoneNodeIds[z])
    }
  }

  // Config de la sala: flota + vehículo personal + decisiones de cada usuario.
  simInfo() {
    const fleets = []
    for (const [slot, f] of this.agents.fleets) {
      if (slot >= PERSONAL_OFFSET) continue
      const route = this.routesByUser.get(slot)
      const p = this.agents.fleets.get(slot + PERSONAL_OFFSET)
      fleets.push({
        slot,
        origin: route?.origin ?? null, dest: route?.dest ?? null,
        count: f.count, spawnBatch: f.spawnBatch, spawnEvery: f.spawnIntervalMs / 1000,
        invoked: f.invoked, spawned: f.spawned, arrived: f.arrived,
        personal: p
          ? { invoked: p.invoked, active: (p.remaining + p.pending > 0) || p.spawned > p.arrived, arrived: p.arrived }
          : { invoked: false, active: false, arrived: 0 },
        decisions: this.decisions.filter(d => d.userId === slot).length,
      })
    }
    return { type: 'sim_info', run: this.run, running: this.running, incidentFreq: this.incidentFreq, tickHz: 20, fleets }
  }

  // Snapshot compacto: avatares [id,x,z,heading,state,owner] + incidentes [id,tipo,x,z]
  snapshot() {
    const as = this.agents
    const a = []
    for (let i = 0; i < as.agentCount; i++) {
      if (!as.active[i]) continue
      a.push(i, r2(as.posX[i]), r2(as.posZ[i]), r2(as.heading[i]), as.state[i], as.owner[i])
    }
    // zonas rojas activas → overlay en los clientes (índices de celda 6×6).
    // FUENTE: detector Spark (red-points), NO ZoneSystem (ver applySparkRedZones).
    const rz = [...this._sparkRedZones]
    return {
      type: 'world_snapshot',
      run: this.run,
      tick: this.tick,
      time: +this.time.toFixed(3),
      phase: this.traffic.phaseIndex,
      running: this.running,
      spawned: as.spawned,
      arrived: as.arrivedCount,
      a,
      inc: this.incidents.snapshotFlat(),
      rz,
    }
  }
}

function resolveTimeout(sim, slot, offer) {
  sim.resolveDecision(slot, offer.vehicleId, 'keep', 'timeout')
}

// Penaliza (o limpia) todas las aristas de una zona en el estado del grafo de la
// sala — mismo efecto que setEdgePenalty2 de ZoneSystem, replicado aquí para
// aplicar las zonas rojas de Spark sin depender del bucle interno de ZoneSystem.
function setZoneEdgePenalty(edges, penalty, state) {
  for (const e of edges) setEdgePenalty(e.a, e.b, penalty, state)
}

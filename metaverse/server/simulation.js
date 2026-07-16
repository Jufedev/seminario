// ════════════════════════════════════════════════════════════════
//  SIMULACIÓN AUTORITATIVA (M4) — además de las flotas (M3), cada
//  usuario tiene UN VEHÍCULO PERSONAL (owner = slot + 100) que CONDUCE
//  EL USUARIO (freeDrive):
//  · No AVANZA solo: va mientras su dueño mantenga el acelerador
//    (drive_throttle). Sin acelerador se comporta como si tuviera el
//    semáforo en rojo, así que la fila y el car-following lo tratan
//    igual que a cualquier auto detenido.
//  · No se rerutea solo: ante un atasco o un bloqueo se queda donde
//    está y espera la decisión de su dueño (ver onRerouteIntercept).
//    Las flotas de M3 conservan intacto su reruteo automático.
//  · El usuario elige la salida del cruce con drive_intent y recibe
//    drive_state por el outbox; sin pedir nada, el vehículo sigue
//    recto.
//  · Si el usuario no invoca su vehículo a tiempo → alerta al admin,
//    que puede invocarlo por él.
// ════════════════════════════════════════════════════════════════
import {
  POINTS, pointNode, allEdges, createEdgeState, resetGraph,
  dijkstra, pathLengthUnits, UNIT_TO_METERS, setEdgePenalty, isEdgeBlocked,
} from './graph.js'
import { TrafficSystem } from '../src/sim/traffic.js'
import { AgentSystem, AGENT_STATE } from '../src/sim/agents.js'
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
const ALERT_AFTER_MS = 15000   // ruta configurada sin invocar el personal → alerta al admin

const DRIVE_DIRS = ['left', 'straight', 'right']   // las ÚNICAS intenciones que acepta el servidor

const POS_SAMPLE_S = 1         // cadencia del feed por-avatar hacia Spark (avatar-positions): ~1 Hz, NO 20 Hz

// Cada cuánto se recalcula la ruta sugerida del vehículo personal (la línea
// punteada). Se recalcula POR RELOJ y no con un contador de versión del grafo, que
// sería más preciso pero habría que acordarse de tocarlo en cada lugar que muta una
// arista —zonas rojas, incidente que empieza, incidente que expira, reset—: olvidar
// uno solo deja la línea punteada vieja SIN ningún error, y una recomendación que
// miente en silencio es peor que no tenerla. Por reloj no puede quedar rancia.
// El costo es despreciable: ~2.5 Dijkstra/s por vehículo sobre 208 nodos, y hay 3
// vehículos como mucho.
const SUGGEST_EVERY_S = 0.4
// Penalización a Dijkstra por arista de una zona roja de Spark. El peso de una
// arista es su distancia euclídea (~30 por cuadra): con 40 cruzar la zona
// costaba apenas ~1 cuadra extra y Dijkstra seguía atravesándola. Con 500
// cualquier desvío realista es más barato que cruzar.
const SPARK_ZONE_PENALTY = 500

const clamp = (v, [lo, hi], fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const r2 = v => Math.round(v * 100) / 100

export class Simulation {
  constructor(label = '', epoch = '') {
    this.label = label ? ` ${label}` : ''
    // Nonce de creación de la sala: distingue reusos de un mismo código de sala
    // (tras el barrido de salas vacías) en el estado por ventana del detector Spark.
    this.epoch = String(epoch)
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
    // M5: la analítica de zonas (índice C; grilla de config.js) corre en el servidor
    // en modo SOLO MÉTRICAS: emite analytics.snapshot para el dashboard del admin
    // (heatmap de C, C̄ global, zona crítica) pero jamás penaliza ni rerutea —
    // la detección de zonas rojas es exclusiva del pipeline Spark.
    this.zones = new ZoneSystem(fakeScene, {
      agentSystem: this.agents, incidentManager: this.incidents,
      headless: true, metricsOnly: true, graphState: this.graphState,
    })
    this.routesByUser = new Map()   // slot → {origin, dest, optimal_m} (para sim_info y eficiencia)
    this._installDriveIntercept()

    // ── Estado M4: mensajes dirigidos y alertas de invocación ──
    this.outbox = []                     // mensajes dirigidos: {to: slot|'admin', msg}
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
    // reruteo. Índices de zona de la grilla + unión de sus node ids (para la caché de rutas).
    this._sparkRedZones = new Set()
    this._sparkRedNodeIds = new Set()

    // ── drive_state: último estado ENVIADO por avatar (agent index → clave) ──
    // Existe para emitir solo ante un cambio real: sin esto habría un mensaje por
    // tick (20 Hz) por vehículo, que es justo lo que world_snapshot ya hace bien.
    this._driveStateSent = new Map()

    // ── Ruta sugerida (línea punteada): agent index → { at, route } ──
    // Cachea el Dijkstra penalizado para no correrlo a 20 Hz (ver SUGGEST_EVERY_S).
    this._suggestCache = new Map()

    // La caché de rutas evita las zonas rojas de SPARK: la detección vive en el Big Data.
    this._installSparkRedChecker()
  }

  // ── El vehículo personal NO se rerutea solo: lo conduce su dueño ──
  // Devolver true = "yo me hago cargo, no rerutees". _triggerReroute pisa pathNodes
  // con un Dijkstra nuevo: sobre una conducción libre eso borraría el volante del
  // usuario EN SILENCIO — sin error, sin choque, con el carro en otra calle. Por eso
  // el gancho intercepta los tres motivos ('atascado', 'zona_roja', 'incidente') y
  // deja al vehículo quieto donde está, esperando el giro que decida su dueño.
  //
  // Para TODO avatar de flota devuelve false, que es exactamente lo que veía el motor
  // con el gancho en null: el reruteo automático de M3 queda intacto.
  //
  // Se instala una sola vez: _reset() recrea el ZoneSystem, pero NO el AgentSystem.
  _installDriveIntercept() {
    this.agents.onRerouteIntercept = i => this.agents.freeDrive[i] === 1
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
  // Nace en conducción libre y QUIETO: espera a que su dueño ponga el acelerador
  // (ver setDriveThrottle). Ya andando, sin intención sigue recto, obedece
  // semáforos y hace fila detrás de la flota, pero no se rerutea solo.
  // source: 'usuario' | 'admin' (el admin puede invocarlo tras la alerta)
  invokePersonal(slot, source = 'usuario') {
    const route = this.routesByUser.get(slot)
    if (!route) return false
    const owner = slot + PERSONAL_OFFSET
    const oNode = pointNode(route.origin), dNode = pointNode(route.dest)
    let fleet = this.agents.fleets.get(owner)
    if (!fleet) fleet = this.agents.addFleet(owner, { originId: oNode, destId: dNode, count: 1, spawnBatch: 1, spawnIntervalMs: 500, priority: true, freeDrive: true })
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

  // ── Volante del vehículo personal (M4) ──
  // `dir` viene del cliente: se valida contra las tres literales, y el nodo que
  // resulta lo valida _applyIntent contra la adyacencia del GRAPH (un giro que la
  // malla no tiene se descarta y el lookahead actual se conserva). El cliente no
  // nombra ni el vehículo ni el nodo: el slot lo pone el socket y el resto sale del
  // estado autoritativo, así que no hay movimiento ilegal que expresar.
  // Devuelve true solo si la intención quedó aplicada.
  setDriveIntent(slot, dir) {
    if (!DRIVE_DIRS.includes(dir)) return false
    const i = this._personalAgent(slot)
    return i < 0 ? false : this.agents._applyIntent(i, dir)
  }

  // Acelerador del vehículo personal: `on` es SOSTENIDO (vale hasta que el dueño
  // suelte la tecla), a diferencia de la intención de giro, que es un evento de un
  // solo uso. Son dos mensajes por pisada, no un canal de 20 Hz.
  // El vehículo no acelera solo: sin esto en 1, _stepAgent lo trata como si tuviera
  // el semáforo en rojo. Y no hay reversa que expresar — `on` es un booleano.
  setDriveThrottle(slot, on) {
    const i = this._personalAgent(slot)
    if (i < 0) return false
    this.agents.throttle[i] = on ? 1 : 0
    return true
  }

  // Índice del vehículo personal VIVO del usuario, o -1. Los índices no se reciclan
  // dentro de una corrida: los personales ya llegados siguen ahí con el mismo owner,
  // y por eso se descartan por estado y no por dueño.
  _personalAgent(slot) {
    const as = this.agents
    const owner = slot + PERSONAL_OFFSET
    for (let i = 0; i < as.agentCount; i++) {
      if (as.owner[i] !== owner || !as.freeDrive[i]) continue
      if (!as.active[i] || as.state[i] === AGENT_STATE.ARRIVED) continue
      return i
    }
    return -1
  }

  // Estado del volante que ve el dueño: el cruce que viene, qué giros existen ahí y
  // si el tramo de más allá está bloqueado por un incidente. blockedAhead se LEE del
  // grafo (no se acumula desde el gancho 'bloqueado' de _stepAgent): así se apaga
  // solo cuando el incidente expira, sin estado que mantener sincronizado.
  // Por la invariante de ≥2 tramos por delante, path[k+1] y path[k+2] siempre existen
  // mientras el avatar no haya llegado.
  _driveStateFor(i) {
    const as = this.agents
    const path = as.pathNodes[i]
    const k = as.segIndex[i]
    const from = path[k], next = path[k + 1]
    const options = {}
    for (const d of DRIVE_DIRS) options[d] = as._neighborInDirection(from, next, d) !== null
    return {
      type: 'drive_state',
      vehicleId: i,
      nextNode: next,
      pending: as.intent[i] ?? null,
      options,
      blockedAhead: isEdgeBlocked(next, path[k + 2], this.graphState),
      route: this._suggestedRoute(i),
    }
  }

  // Ruta más rápida DESDE el cruce que viene HASTA el destino, sobre el grafo de
  // ESTA sala: las zonas rojas de Spark (penalización) y los tramos bloqueados por
  // incidentes ya están adentro. Es la línea PUNTEADA del cliente.
  //
  // Su contraparte es la línea sólida, que el cliente calcula con el mismo Dijkstra
  // pero sobre el grafo LIMPIO (`dijkstra(a, b)` sin state → la ruta ideal, como si
  // no hubiera pasado nada). Que las dos se separen es la congestión hecha visible:
  // la sólida es el plan, la punteada es lo que conviene AHORA.
  //
  // Arranca en `path[k+1]` —el cruce que viene— y no en la posición del auto: entre
  // dos cruces ya no se puede elegir, así que sugerir desde el nodo de atrás daría
  // una ruta que pide un giro imposible.
  _suggestedRoute(i) {
    const c = this._suggestCache.get(i)
    if (c && this.time - c.at < SUGGEST_EVERY_S) return c.route
    const as = this.agents
    const from = as.pathNodes[i][as.segIndex[i] + 1]   // la invariante de ≥2 tramos lo garantiza
    const route = dijkstra(from, as.destNode[i], this.graphState) ?? []
    this._suggestCache.set(i, { at: this.time, route })
    return route
  }

  // Encola drive_state al dueño SOLO cuando cambió algo. En la práctica eso es un
  // mensaje por cruce (~8 s) más uno por intención aceptada: no es un canal de 20 Hz
  // y por eso no viaja en world_snapshot (broadcast a todos) ni en sim_info.
  _pumpDriveState() {
    const as = this.agents
    for (let i = 0; i < as.agentCount; i++) {
      if (!as.freeDrive[i]) continue
      // Llegó (o lo borró un reset): que la próxima invocación vuelva a emitir de cero
      if (!as.active[i] || as.state[i] === AGENT_STATE.ARRIVED) {
        this._driveStateSent.delete(i)
        this._suggestCache.delete(i)   // su ruta sugerida murió con él
        continue
      }
      const msg = this._driveStateFor(i)
      // La ruta entra en la clave: es lo que cambia cuando Spark pinta una zona roja
      // sin que el vehículo se haya movido, y es justo el momento que hay que mostrar.
      const key = `${msg.nextNode}|${msg.pending}|${msg.options.left}${msg.options.straight}${msg.options.right}|${msg.blockedAhead}|${msg.route.join('>')}`
      if (this._driveStateSent.get(i) === key) continue
      this._driveStateSent.set(i, key)
      this.outbox.push({ to: as.owner[i] - PERSONAL_OFFSET, msg })
    }
  }

  _fleetDefaults() {
    return {
      count: FLEET_DEFAULTS.count,
      spawnBatch: FLEET_DEFAULTS.spawnBatch,
      spawnIntervalMs: FLEET_DEFAULTS.spawnEvery * 1000,
    }
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
    // INTENCIONAL: en pausa las zonas rojas se apagan solas en ~15s. Al pausar,
    // index.js deja de muestrear posiciones (maybeSampleAvatarPositions solo corre
    // con la sala en marcha), Spark deja de re-emitir y las zonas mueren por TTL.
    // Es correcto: nada se mueve, no hay congestión viva que detectar. No es un bug.
    else if (action === 'pause') this.running = false
    else if (action === 'reset') this._reset()
    else return false
    kafka.send('room.lifecycle', { action: 'control', value: action })
    console.log(`[sim${this.label}] admin: ${action}`)
    return true
  }

  // Reset: mundo vacío, sin incidentes, tiempo a cero. Las CONFIGURACIONES
  // de flota/ruta se conservan; las alertas de invocación se rearman.
  _reset() {
    this.agents.resetAgents()
    this.incidents.clearAll()
    resetGraph(this.graphState)
    // zonas frescas (historial de C̄ y banderas rojas a cero para la corrida nueva)
    this.zones.dispose()
    this.zones = new ZoneSystem(fakeScene, {
      agentSystem: this.agents, incidentManager: this.incidents,
      headless: true, metricsOnly: true, graphState: this.graphState,
    })
    this.personalInvoked.clear()
    this.alertSent.clear()
    this._driveStateSent.clear()   // resetAgents() borró los avatares: no hay estado que recordar
    // Y la ruta sugerida de cada uno, por lo mismo. Obligatorio, no higiene: abajo
    // `this.time` vuelve a 0, así que una entrada vieja deja `time - at` NEGATIVO y
    // el guardia de frescura (`< SUGGEST_EVERY_S`) la da por fresca durante toda la
    // corrida nueva. La caché se indexa por posición en el array de agentes, y
    // resetAgents() reinicia el contador: el vehículo nuevo hereda la clave —y la
    // ruta— del viejo.
    this._suggestCache.clear()
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

  // Un tick de simulación (20 Hz). En pausa el mundo no avanza.
  step(dt) {
    this.tick++
    if (!this.running) return
    this.time += dt
    this.traffic.update(dt)
    this.agents.update(dt, this.time)
    this._pumpDriveState()   // después de update(): el cruce ya se consumió y la intención ya se limpió
    this.incidents.update(dt, this.time)
    // ZoneSystem corre en modo SOLO MÉTRICAS (ver constructor): alimenta el
    // dashboard del admin (analytics.snapshot: heatmap de C, C̄, zona crítica)
    // sin tocar el grafo. La DETECCIÓN de zonas rojas — overlay (rz), reruteo y
    // penalizaciones — sigue siendo exclusiva del detector Spark (red-points),
    // aplicada en applySparkRedZones() sobre la geometría de zonas compartida.
    this.zones.update(dt, this.time)
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
      // pero el payload va ÚLTIMO → su ts ISO gana. avatar_id lleva la sala + su
      // epoch de creación → conteo de avatares distintos sin colisión al reusar código.
      batch.push({
        avatar_id: this.epoch ? `${roomCode}-${this.epoch}-${i}` : `${roomCode}-${i}`,
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

  // Config de la sala: flota y vehículo personal de cada usuario.
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
    // zonas rojas activas → overlay en los clientes (índices de celda de la grilla).
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

// Penaliza (o limpia) todas las aristas de una zona en el estado del grafo de la
// sala — mismo efecto que setEdgePenalty2 de ZoneSystem, replicado aquí para
// aplicar las zonas rojas de Spark sin depender del bucle interno de ZoneSystem.
function setZoneEdgePenalty(edges, penalty, state) {
  for (const e of edges) setEdgePenalty(e.a, e.b, penalty, state)
}

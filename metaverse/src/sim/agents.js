import * as THREE from 'three'
import { NODES, GRAPH, dijkstra, isEdgeBlocked, DEFAULT_EDGE_STATE, UNIT_TO_METERS } from '../graph/mapData.js'
import { kafka } from '../kafka/producer.js'
import { SIM_CONFIG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  AGENTES — hasta 500 avatares en UN solo InstancedMesh (1 draw call).
//  El estado vive en typed arrays (Struct of Arrays), no en objetos.
//
//  M3: soporta FLOTAS por dueño (owner). Cada flota tiene su propia
//  ruta O→D, cantidad y ritmo de oleadas, y se invoca cuando el dueño
//  quiere. TODAS las flotas comparten el mismo mundo: mismas calles,
//  filas, semáforos e incidentes (car-following global entre flotas).
//  El modo clásico (offline, una sola ruta) es una flota auto-invocada.
//
//  Reglas de tráfico:
//   · 2 carriles por sentido → máximo 2 avatares lado a lado.
//   · Car-following estricto: MIN_GAP entre centros > largo del carro.
//   · Spawn por oleadas: solo salen si hay hueco físico en el tramo.
//   · Semáforo por eje y por cruce; tramos con incidente NO se cruzan.
// ════════════════════════════════════════════════════════════════

// Margen de tolerancia entre la posición (Float32Array, precisión reducida) y las
// longitudes de tramo (calculadas en float64 cada frame) — ver el comentario en _stepAgent.
const SEG_EPS = 0.01

export const AGENT_STATE = { MOVING: 0, WAITING: 1, STUCK: 2, ARRIVED: 3 }
// Exportado: la vista online usa la misma paleta para los avatares remotos
export const STATE_COLOR = {
  [AGENT_STATE.MOVING]: new THREE.Color(0x3b82f6),
  [AGENT_STATE.WAITING]: new THREE.Color(0xfbbf24),
  [AGENT_STATE.STUCK]: new THREE.Color(0xf87171),
  [AGENT_STATE.ARRIVED]: new THREE.Color(0x34d399),
}

function edgeKind(aId, bId) {
  for (const e of (GRAPH[aId] || [])) if (e.to === bId) return e.kind
  return null
}
// Eje de circulación de cada tramo: 'carrera' = Norte-Sur, 'calle' = Este-Oeste
function computeAxes(path) {
  const axes = new Array(path.length - 1)
  for (let k = 0; k < path.length - 1; k++) {
    const kind = edgeKind(path[k], path[k + 1])
    axes[k] = kind === 'carrera' ? 'NS' : kind === 'calle' ? 'EW' : null
  }
  return axes
}

export class AgentSystem {
  // Modo clásico (offline): { total, originId, destId, spawnBatch, spawnIntervalMs, traffic }
  // Modo flotas (server):   { maxAgents, traffic, graphState } + addFleet()/invokeFleet()
  constructor(scene, opts) {
    const classic = opts.total != null && opts.originId && opts.destId
    this.scene = scene
    this.traffic = opts.traffic
    this.graphState = opts.graphState ?? DEFAULT_EDGE_STATE
    this.maxAgents = classic
      ? Math.max(1, Math.min(SIM_CONFIG.MAX_AGENTS, opts.total))
      : (opts.maxAgents ?? SIM_CONFIG.MAX_AGENTS)
    this.total = this.maxAgents   // en modo clásico = total pedido (fin-de-sim del offline)

    this.simTime = 0
    this.spawned = 0          // global (todas las flotas)
    this.agentCount = 0       // índices de avatar ya asignados (nunca se reciclan en una corrida)
    this.arrivedCount = 0
    this.rerouteCount = 0
    this.rerouteByReason = { atascado: 0, zona_roja: 0, incidente: 0 }
    this._kafkaSampleTimer = 0
    this.fleets = new Map()   // owner → flota

    // Caché de rutas O→D POR INSTANCIA (cada sala tiene su grafo/estado propio).
    // Casi todos los avatares de una flota comparten ruta → 1 Dijkstra por O/D.
    this._routeCache = new Map()
    this._redZoneChecker = () => false   // lo conecta la analítica de zonas (offline)
    // Gancho M4: si devuelve true, el auto-reroute de ese avatar queda en manos de
    // quien interceptó (el servidor pausa el vehículo personal y ofrece la decisión).
    this.onRerouteIntercept = null

    // Aristas con avatares circulando ahora mismo → nº de avatares sobre cada una.
    // Los incidentes se colocan donde hay más tráfico (más realista y concentra congestión).
    this.occupiedEdges = new Map()

    // ── Un solo InstancedMesh para todos los avatares (1 draw call) ──
    const geo = new THREE.BoxGeometry(1.3, 1.1, SIM_CONFIG.CAR_LENGTH)
    const mat = new THREE.MeshBasicMaterial()
    this.mesh = new THREE.InstancedMesh(geo, mat, this.maxAgents)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    // ── Struct of Arrays: estado de cada avatar (nada de objetos por avatar) ──
    const n = this.maxAgents
    this.active = new Uint8Array(n)
    this.state = new Uint8Array(n)
    this.paused = new Uint8Array(n)           // M4: pausado mientras su dueño decide la ruta
    this.owner = new Int16Array(n).fill(-1)   // dueño (slot de usuario); -1 = sin asignar
    this.pathNodes = new Array(n)
    this.pathAxis = new Array(n)
    this.segIndex = new Int32Array(n)
    this.segDist = new Float32Array(n)
    this.speed = new Float32Array(n)
    this.speedFactor = new Float32Array(n)
    this.lane = new Uint8Array(n)
    this.distTraveled = new Float32Array(n)
    this.spawnTime = new Float32Array(n)
    this.arriveTime = new Float32Array(n)
    this.posX = new Float32Array(n)
    this.posZ = new Float32Array(n)
    this.heading = new Float32Array(n)
    this.stuckTimer = new Float32Array(n)
    this.stuckAccum = new Float32Array(n)
    this.lastCheckX = new Float32Array(n)
    this.lastCheckZ = new Float32Array(n)

    // Temporales reutilizables — se crean una sola vez, se reescriben cada frame
    this._m4 = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._euler = new THREE.Euler()
    this._scaleOne = new THREE.Vector3(1, 1, 1)
    this._scaleZero = new THREE.Vector3(0, 0, 0)
    this._pos = new THREE.Vector3()
    this._groups = new Map()

    for (let i = 0; i < n; i++) this._writeHidden(i)
    this.mesh.instanceMatrix.needsUpdate = true

    // Modo clásico: una flota (owner 0) con los parámetros de siempre, invocada ya
    if (classic) {
      this.addFleet(0, {
        originId: opts.originId, destId: opts.destId, count: this.maxAgents,
        spawnBatch: opts.spawnBatch ?? 1, spawnIntervalMs: opts.spawnIntervalMs ?? 500,
      })
      this.invokeFleet(0)
    }
  }

  // ── API de flotas (M3) ──
  // priority: true = sale ANTES que las flotas normales cuando compiten por el
  // mismo hueco de salida (M4: el vehículo personal no espera detrás de la flota)
  addFleet(owner, { originId, destId, count = 10, spawnBatch = 5, spawnIntervalMs = 2000, priority = false }) {
    this.fleets.set(owner, {
      owner, originNode: originId, destNode: destId,
      count: Math.max(1, count), spawnBatch: Math.max(1, spawnBatch),
      spawnIntervalMs: Math.max(100, spawnIntervalMs),
      priority,
      remaining: 0,     // cupos por soltar (los agrega cada invocación)
      pending: 0,       // cupos ya liberados por oleada, esperando hueco físico
      timerMs: 0,
      spawned: 0, arrived: 0, invoked: false,
    })
    return this.fleets.get(owner)
  }

  setFleetRoute(owner, originNode, destNode) {
    const f = this.fleets.get(owner) ?? this.addFleet(owner, { originId: originNode, destId: destNode })
    f.originNode = originNode
    f.destNode = destNode   // aplica a los próximos spawns; los que van en camino conservan su destino
  }

  setFleetParams(owner, { count, spawnBatch, spawnIntervalMs }) {
    const f = this.fleets.get(owner)
    if (!f) return
    if (count != null) f.count = Math.max(1, count)
    if (spawnBatch != null) f.spawnBatch = Math.max(1, spawnBatch)
    if (spawnIntervalMs != null) f.spawnIntervalMs = Math.max(100, spawnIntervalMs)
  }

  // Invocar = encolar `count` vehículos más (invocar de nuevo suma otra tanda)
  invokeFleet(owner) {
    const f = this.fleets.get(owner)
    if (!f || !f.originNode || !f.destNode) return false
    f.remaining += f.count
    f.timerMs = f.spawnIntervalMs   // la primera oleada sale de inmediato
    f.invoked = true
    return true
  }

  // ── Caché de rutas e invalidaciones (por instancia) ──
  _getCachedRoute(originId, destId) {
    const key = `${originId}|${destId}`
    const cached = this._routeCache.get(key)
    if (cached && !this._redZoneChecker(cached)) return cached
    const path = dijkstra(originId, destId, this.graphState)
    if (path) this._routeCache.set(key, path)
    return path
  }

  setRedZoneChecker(fn) { this._redZoneChecker = fn }

  invalidateRoutesThroughZone(nodeIds) {
    const affected = nodeIds instanceof Set ? nodeIds : new Set(nodeIds)
    for (const [key, path] of this._routeCache) if (path.some(n => affected.has(n))) this._routeCache.delete(key)
  }

  invalidateRoutesThroughEdge(aId, bId) {
    for (const [key, path] of this._routeCache) {
      for (let k = 0; k < path.length - 1; k++) {
        if ((path[k] === aId && path[k + 1] === bId) || (path[k] === bId && path[k + 1] === aId)) {
          this._routeCache.delete(key)
          break
        }
      }
    }
  }

  // ── Ciclo principal: llamado una vez por tick/frame ──
  update(dt, simTime) {
    this.simTime = simTime
    this._trySpawn(dt)

    // Pase 1: agrupar avatares por (tramo actual + carril) para car-following barato.
    // Nota: TODAS las flotas entran al mismo grupo → se hacen fila entre sí.
    const groups = this._groups
    groups.clear()
    this.occupiedEdges.clear()
    for (let i = 0; i < this.agentCount; i++) {
      if (!this.active[i] || this.state[i] === AGENT_STATE.ARRIVED) continue
      const path = this.pathNodes[i]
      const a = path[this.segIndex[i]], b = path[this.segIndex[i] + 1]
      const key = `${a}>${b}_${this.lane[i]}`
      let arr = groups.get(key)
      if (!arr) { arr = []; groups.set(key, arr) }
      arr.push(i)
      const ek = a < b ? `${a}|${b}` : `${b}|${a}`
      this.occupiedEdges.set(ek, (this.occupiedEdges.get(ek) || 0) + 1)
    }
    for (const arr of groups.values()) arr.sort((a, b) => this.segDist[b] - this.segDist[a])

    let moving = 0, waiting = 0, stuck = 0, speedSum = 0
    for (let i = 0; i < this.agentCount; i++) {
      if (!this.active[i]) continue
      if (this.state[i] === AGENT_STATE.ARRIVED) continue
      // M4: pausado decidiendo — no avanza, pero sigue en su grupo (los de atrás hacen fila)
      if (this.paused[i]) {
        this.speed[i] = 0
        this.state[i] = AGENT_STATE.WAITING
        waiting++
        continue
      }
      this._stepAgent(i, dt, groups)
      if (this.state[i] === AGENT_STATE.WAITING) waiting++
      else if (this.state[i] === AGENT_STATE.STUCK) stuck++
      else moving++
      speedSum += this.speed[i]
    }

    this._writeInstances()

    // Muestreo agregado a Kafka (no por avatar, no cada frame)
    this._kafkaSampleTimer += dt * 1000
    if (this._kafkaSampleTimer >= SIM_CONFIG.KAFKA_SAMPLE_MS) {
      this._kafkaSampleTimer = 0
      kafka.send('agent.position', {
        sampled_at: Date.now(), moving, waiting, stuck,
        arrived: this.arrivedCount, avg_speed_mps: +((speedSum / Math.max(1, moving + waiting)) * UNIT_TO_METERS).toFixed(2),
      })
    }

    return { moving, waiting, stuck, arrived: this.arrivedCount, spawned: this.spawned, total: this.total }
  }

  // ── Salida por OLEADAS, por flota: cada spawnIntervalMs se liberan spawnBatch
  //    cupos; se colocan solo cuando hay hueco físico en el tramo de salida. ──
  _trySpawn(dt) {
    // primero las flotas con prioridad (vehículos personales), luego las normales
    const ordered = [...this.fleets.values()].sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0))
    for (const fleet of ordered) {
      if (fleet.remaining > 0) {
        fleet.timerMs += dt * 1000
        while (fleet.timerMs >= fleet.spawnIntervalMs && fleet.remaining > 0) {
          fleet.timerMs -= fleet.spawnIntervalMs
          const take = Math.min(fleet.spawnBatch, fleet.remaining)
          fleet.pending += take
          fleet.remaining -= take
        }
      }
      while (fleet.pending > 0 && this.agentCount < this.maxAgents && this._spawnOne(this.agentCount, fleet)) {
        this.agentCount++
        fleet.pending--
        fleet.spawned++
        this.spawned++
      }
    }
  }

  // Carril de salida con hueco suficiente en el primer tramo de la ruta, o -1 si no hay.
  _pickSpawnLane(aId, bId) {
    let min0 = Infinity, min1 = Infinity   // distancia del avatar MÁS ATRASADO en cada carril
    for (let j = 0; j < this.agentCount; j++) {
      if (!this.active[j] || this.state[j] === AGENT_STATE.ARRIVED) continue
      const p = this.pathNodes[j]
      if (p[this.segIndex[j]] !== aId || p[this.segIndex[j] + 1] !== bId) continue
      const d = this.segDist[j]
      if (this.lane[j] === 0) { if (d < min0) min0 = d } else { if (d < min1) min1 = d }
    }
    const H = SIM_CONFIG.SPAWN_HEADROOM
    if (min0 < H && min1 < H) return -1                                   // ambos carriles llenos en la salida
    if (min0 === Infinity && min1 === Infinity) return Math.random() < 0.5 ? 0 : 1
    return min0 >= min1 ? 0 : 1                                           // el carril con más hueco
  }

  // Devuelve true si el avatar quedó activo (o llegó de inmediato); false si no hay
  // ruta o no hay hueco todavía — el cupo NO se consume, se reintenta el próximo tick.
  _spawnOne(i, fleet) {
    const path = this._getCachedRoute(fleet.originNode, fleet.destNode)
    if (!path || path.length < 1) return false   // origen y destino incomunicados ahora mismo

    let lane = 0
    if (path.length > 1) {
      lane = this._pickSpawnLane(path[0], path[1])
      if (lane < 0) return false                 // sin hueco físico en el tramo de salida
    }

    this.active[i] = 1
    this.paused[i] = 0
    this.owner[i] = fleet.owner
    this.pathNodes[i] = path
    this.pathAxis[i] = computeAxes(path)
    this.segIndex[i] = 0
    this.segDist[i] = 0
    this.lane[i] = lane
    this.speed[i] = 0
    this.speedFactor[i] = 0.85 + Math.random() * 0.3
    this.distTraveled[i] = 0
    this.spawnTime[i] = this.simTime
    this.stuckTimer[i] = 0
    this.stuckAccum[i] = 0

    const n0 = NODES[path[0]]
    this.posX[i] = n0.x; this.posZ[i] = n0.z
    this.lastCheckX[i] = n0.x; this.lastCheckZ[i] = n0.z

    kafka.send('agent.spawn', { agent_id: i, owner: fleet.owner, origin: fleet.originNode, dest: fleet.destNode, ts: Date.now() })

    // Origen === destino (caso borde): llega en el mismo instante que sale
    if (path.length === 1) { this._arrive(i); return true }

    this.state[i] = AGENT_STATE.MOVING
    return true
  }

  // ── Avance de un avatar: semáforo/bloqueo → car-following → interpolación → atasco ──
  _stepAgent(i, dt, groups) {
    const path = this.pathNodes[i]
    let idx = this.segIndex[i]
    if (idx >= path.length - 1) { this._arrive(i); return }

    const a = NODES[path[idx]], b = NODES[path[idx + 1]]
    const dx = b.x - a.x, dz = b.z - a.z
    const segLen = Math.hypot(dx, dz)

    // Cerca del cruce (y no en el último tramo): evaluar semáforo del eje propio
    // y si el tramo SIGUIENTE está bloqueado por un incidente.
    let lightStop = false, blockStop = false
    if (idx < path.length - 2 && segLen - this.segDist[i] < SIM_CONFIG.STOP_DISTANCE) {
      const axis = this.pathAxis[i][idx]
      if (axis && !this.traffic.isGreenForAxis(path[idx + 1], axis)) lightStop = true
      if (isEdgeBlocked(path[idx + 1], path[idx + 2], this.graphState)) {
        blockStop = true
        // M4: el vehículo personal ofrece la decisión apenas queda de frente al bloqueo
        // (el gancho dedup-ea internamente: oferta pendiente/cooldown → no hace nada)
        this.onRerouteIntercept?.(i, 'bloqueado', path[idx + 1], path[idx + 2])
      }
    }
    const mustStop = lightStop || blockStop

    // Car-following: no puedo pasar al de adelante en mi mismo tramo+carril.
    // Se salta líderes que ya cruzaron a otro tramo este mismo frame (su segDist
    // pertenece al tramo nuevo y clavaría al seguidor en 0 por un frame).
    const key = `${path[idx]}>${path[idx + 1]}_${this.lane[i]}`
    const group = groups.get(key)
    let maxSegDist = segLen
    if (group) {
      const pos = group.indexOf(i)
      for (let g = pos - 1; g >= 0; g--) {
        const j = group[g]
        if (this.state[j] === AGENT_STATE.ARRIVED) continue
        const pj = this.pathNodes[j]
        if (pj[this.segIndex[j]] === path[idx] && pj[this.segIndex[j] + 1] === path[idx + 1]) {
          maxSegDist = Math.min(segLen, this.segDist[j] - SIM_CONFIG.MIN_GAP)
          break
        }
      }
    }

    const targetSpeed = mustStop ? 0 : SIM_CONFIG.AGENT_SPEED * this.speedFactor[i]
    this.speed[i] += (targetSpeed - this.speed[i]) * Math.min(1, dt * 4)
    if (this.speed[i] < 0) this.speed[i] = 0

    const newSegDist = this.segDist[i] + this.speed[i] * dt
    this.segDist[i] = Math.max(0, Math.min(newSegDist, maxSegDist))
    // ¿Está detenido haciendo FILA detrás de otro? (no es atasco: es tráfico normal)
    const queued = maxSegDist < segLen - SEG_EPS && this.segDist[i] >= maxSegDist - 0.05

    if (this.state[i] !== AGENT_STATE.STUCK) {
      this.state[i] = (mustStop || queued) ? AGENT_STATE.WAITING : AGENT_STATE.MOVING
    }

    // Avanza de tramo si completó el actual (nunca el último, ese lo cierra _arrive).
    // SEG_EPS: segDist vive en un Float32Array (precisión reducida) pero segLen se calcula
    // en float64 cada frame; sin este margen, un avatar sin líder por delante queda clavado
    // para siempre justo en el borde del tramo, y todos detrás heredan el atasco eterno.
    while (this.segIndex[i] < path.length - 2) {
      const ii = this.segIndex[i]
      const na = NODES[path[ii]], nb = NODES[path[ii + 1]]
      const len = Math.hypot(nb.x - na.x, nb.z - na.z)
      if (this.segDist[i] < len - SEG_EPS) break

      const nextA = path[ii + 1], nextB = path[ii + 2]
      // NUNCA entrar a un tramo bloqueado por incidente: espera en el nodo
      if (isEdgeBlocked(nextA, nextB, this.graphState)) { this.segDist[i] = len; break }

      // Al cruzar, respetar la cola del tramo nuevo (no aterrizar encima del último de la fila)
      let carry = this.segDist[i] - len
      const nextKey = `${nextA}>${nextB}_${this.lane[i]}`
      let ng = groups.get(nextKey)
      if (ng) {
        let tail = -1
        for (let g = ng.length - 1; g >= 0; g--) {
          const j = ng[g]
          if (this.state[j] === AGENT_STATE.ARRIVED) continue
          const pj = this.pathNodes[j]
          if (pj[this.segIndex[j]] === nextA && pj[this.segIndex[j] + 1] === nextB) { tail = j; break }
        }
        if (tail >= 0) {
          // la entrada del tramo nuevo está ocupada → espera en el nodo hasta que se despeje
          if (this.segDist[tail] < SIM_CONFIG.MIN_GAP) { this.segDist[i] = len; break }
          carry = Math.min(carry, this.segDist[tail] - SIM_CONFIG.MIN_GAP)
        }
      }
      this.segDist[i] = Math.max(0, carry)
      this.segIndex[i]++
      this.distTraveled[i] += len
      // se registra en el grupo nuevo para que quien cruce después lo respete
      if (!ng) { ng = []; groups.set(nextKey, ng) }
      ng.push(i)   // entra con el segDist más bajo → mantiene el orden descendente del grupo
    }
    idx = this.segIndex[i]
    const na = NODES[path[idx]], nb = NODES[path[idx + 1]]
    const dx2 = nb.x - na.x, dz2 = nb.z - na.z, len2 = Math.hypot(dx2, dz2) || 1
    if (idx >= path.length - 2 && this.segDist[i] >= len2 - SEG_EPS) { this._arrive(i); return }

    const t = this.segDist[i] / len2
    const px = na.x + dx2 * t, pz = na.z + dz2 * t
    // Offset de carril: perpendicular "derecha" respecto al sentido de avance
    const perpX = -dz2 / len2, perpZ = dx2 / len2
    const laneOffset = SIM_CONFIG.LANE_OFFSET * (0.5 + this.lane[i])
    this.posX[i] = px + perpX * laneOffset
    this.posZ[i] = pz + perpZ * laneOffset
    this.heading[i] = Math.atan2(dx2, dz2)

    // Atasco: NO cuenta si está parado legítimamente (semáforo en rojo o fila normal).
    // Un stop por tramo bloqueado SÍ acumula: así reintenta rerutear cada STUCK_TIME
    // hasta encontrar alternativa o hasta que el incidente expire.
    if (lightStop || queued) { this.stuckTimer[i] = 0; this.stuckAccum[i] = 0; return }
    this.stuckTimer[i] += dt
    if (this.stuckTimer[i] < 1) return
    const moved = Math.hypot(this.posX[i] - this.lastCheckX[i], this.posZ[i] - this.lastCheckZ[i])
    if (moved < 0.15) {
      this.stuckAccum[i] += this.stuckTimer[i]
      if (this.stuckAccum[i] >= SIM_CONFIG.STUCK_TIME) {
        // M4: el vehículo personal no auto-rerutea — su dueño decide (oferta de 5s)
        if (this.onRerouteIntercept?.(i, 'atascado')) { this.stuckAccum[i] = 0 }
        else this._triggerReroute(i, 'atascado')
      }
    } else {
      this.stuckAccum[i] = 0
    }
    this.lastCheckX[i] = this.posX[i]; this.lastCheckZ[i] = this.posZ[i]
    this.stuckTimer[i] = 0
  }

  // ── Reroute individual: NO usa/escribe la caché global, es la ruta propia de este avatar ──
  // motivo: 'atascado' (detectado por el propio avatar) | 'zona_roja' | 'incidente'
  _triggerReroute(i, motivo) {
    if (motivo === 'atascado') this.state[i] = AGENT_STATE.STUCK   // flash rojo visible solo en atasco real
    const path = this.pathNodes[i]
    const destNode = path[path.length - 1]   // el destino es el final de SU ruta (cada flota tiene el suyo)
    const fromNode = path[this.segIndex[i] + 1] ?? path[this.segIndex[i]]
    const newTail = dijkstra(fromNode, destNode, this.graphState)
    this.rerouteCount++
    this.rerouteByReason[motivo] = (this.rerouteByReason[motivo] || 0) + 1
    kafka.send('agent.reroute', { agent_id: i, owner: this.owner[i], motivo, ts: Date.now() })
    if (!newTail || newTail.length < 1) return   // sin alternativa: se queda como estaba

    const newPath = [path[this.segIndex[i]], ...newTail]
    this.pathNodes[i] = newPath
    this.pathAxis[i] = computeAxes(newPath)
    this.segIndex[i] = 0
    // segDist se conserva: sigue el mismo tramo hasta fromNode, luego toma la ruta nueva
    this.stuckAccum[i] = 0
    this.stuckTimer[i] = 0
    if (motivo === 'atascado') this.state[i] = AGENT_STATE.MOVING
  }

  // ── Cuando una zona se pone roja: desvía a los avatares en camino cuya ruta la cruza ──
  rerouteAgentsThroughZone(zoneNodeIds) {
    const set = zoneNodeIds instanceof Set ? zoneNodeIds : new Set(zoneNodeIds)
    for (let i = 0; i < this.agentCount; i++) {
      if (!this.active[i] || this.state[i] === AGENT_STATE.ARRIVED) continue
      const path = this.pathNodes[i]
      let crosses = false
      for (let k = this.segIndex[i] + 1; k < path.length; k++) {
        if (set.has(path[k])) { crosses = true; break }
      }
      // M4: el vehículo personal tampoco auto-rerutea por zona roja — decide su dueño
      if (crosses && !this.onRerouteIntercept?.(i, 'zona_roja')) this._triggerReroute(i, 'zona_roja')
    }
  }

  // ── Cuando nace un incidente: desvía a los avatares cuya ruta RESTANTE usa esa arista.
  //    El que ya está pisando el tramo lo termina (no puede tele-transportarse fuera). ──
  rerouteAgentsThroughEdge(aId, bId) {
    for (let i = 0; i < this.agentCount; i++) {
      if (!this.active[i] || this.state[i] === AGENT_STATE.ARRIVED) continue
      const path = this.pathNodes[i]
      for (let k = this.segIndex[i] + 1; k < path.length - 1; k++) {
        if ((path[k] === aId && path[k + 1] === bId) || (path[k] === bId && path[k + 1] === aId)) {
          // M4: el vehículo personal no auto-rerutea — su dueño decide (oferta de 5s)
          if (!this.onRerouteIntercept?.(i, 'incidente', aId, bId)) this._triggerReroute(i, 'incidente')
          break
        }
      }
    }
  }

  // ── M4: soporte de la decisión de los 5 segundos ──
  setPaused(i, v) { this.paused[i] = v ? 1 : 0 }

  // El usuario eligió "alternativa": recalcular ruta YA (evitando bloqueos actuales)
  forceReroute(i, motivo = 'decision_usuario') { this._triggerReroute(i, motivo) }

  // Distancia restante sobre la ruta actual (unidades de mundo) — para las ETAs
  remainingDistanceUnits(i) {
    const path = this.pathNodes[i]
    if (!path) return 0
    let d = -this.segDist[i]
    for (let k = this.segIndex[i]; k < path.length - 1; k++) {
      const a = NODES[path[k]], b = NODES[path[k + 1]]
      d += Math.hypot(a.x - b.x, a.z - b.z)
    }
    return Math.max(0, d)
  }

  _arrive(i) {
    this.state[i] = AGENT_STATE.ARRIVED
    this.arriveTime[i] = this.simTime
    this.arrivedCount++
    const path = this.pathNodes[i]
    // el bucle de avance nunca suma el ÚLTIMO tramo (lo cierra _arrive): sumarlo aquí,
    // si no distance_m queda corto un tramo y el score de eficiencia sale > 1
    if (path.length > 1) {
      const pa = NODES[path[path.length - 2]], pb = NODES[path[path.length - 1]]
      this.distTraveled[i] += Math.hypot(pa.x - pb.x, pa.z - pb.z)
    }
    const fleet = this.fleets.get(this.owner[i])
    if (fleet) fleet.arrived++
    const dest = NODES[this.pathNodes[i][this.pathNodes[i].length - 1]]
    this.posX[i] = dest.x; this.posZ[i] = dest.z
    kafka.send('agent.arrived', {
      agent_id: i,
      owner: this.owner[i],
      travel_time_s: +(this.simTime - this.spawnTime[i]).toFixed(1),
      distance_m: +(this.distTraveled[i] * UNIT_TO_METERS).toFixed(1),
    })
  }

  // ── Reset (admin_control reset): borra todos los avatares, conserva la config de las flotas ──
  resetAgents() {
    for (let i = 0; i < this.agentCount; i++) {
      this.active[i] = 0
      this.paused[i] = 0
      this.owner[i] = -1
      this.pathNodes[i] = null
      this.pathAxis[i] = null
      this._writeHidden(i)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.agentCount = 0
    this.spawned = 0
    this.arrivedCount = 0
    this.rerouteCount = 0
    this.rerouteByReason = { atascado: 0, zona_roja: 0, incidente: 0 }
    this._routeCache.clear()
    for (const f of this.fleets.values()) {
      f.remaining = 0; f.pending = 0; f.timerMs = 0
      f.spawned = 0; f.arrived = 0; f.invoked = false
    }
  }

  // ── Vuelca posición/color de cada avatar en el InstancedMesh ──
  _writeInstances() {
    for (let i = 0; i < this.agentCount; i++) {
      if (!this.active[i]) { this._writeHidden(i); continue }
      this._euler.set(0, this.heading[i], 0)
      this._q.setFromEuler(this._euler)
      this._pos.set(this.posX[i], 0.55, this.posZ[i])
      this._m4.compose(this._pos, this._q, this._scaleOne)
      this.mesh.setMatrixAt(i, this._m4)
      this.mesh.setColorAt(i, STATE_COLOR[this.state[i]])
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  _writeHidden(i) {
    this._m4.compose(this._pos.set(0, 0, 0), this._q.identity(), this._scaleZero)
    this.mesh.setMatrixAt(i, this._m4)
  }

  // ── Snapshot para el panel de métricas (barato: solo se llama al refrescar el HUD) ──
  getStats() {
    let moving = 0, waiting = 0, stuck = 0, speedSum = 0, active = 0
    for (let i = 0; i < this.agentCount; i++) {
      if (!this.active[i] || this.state[i] === AGENT_STATE.ARRIVED) continue
      active++
      speedSum += this.speed[i]
      if (this.state[i] === AGENT_STATE.WAITING) waiting++
      else if (this.state[i] === AGENT_STATE.STUCK) stuck++
      else moving++
    }
    return {
      spawned: this.spawned, total: this.total, arrived: this.arrivedCount,
      moving, waiting, stuck, active, rerouteCount: this.rerouteCount,
      avgSpeedMps: active ? (speedSum / active) * UNIT_TO_METERS : 0,
    }
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.removeFromParent()
    this._routeCache.clear()
  }
}

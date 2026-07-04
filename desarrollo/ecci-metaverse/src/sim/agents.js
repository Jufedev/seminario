import * as THREE from 'three'
import { NODES, GRAPH, dijkstra, UNIT_TO_METERS } from '../graph/mapData.js'
import { kafka } from '../kafka/producer.js'
import { SIM_CONFIG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  AGENTES — hasta 500 avatares en UN solo InstancedMesh (1 draw call).
//  El estado vive en typed arrays (Struct of Arrays), no en objetos:
//  eso es lo que permite mover 500 avatares por frame sin GC ni
//  reflow. Cada avatar sigue su ruta nodo a nodo, respeta semáforos,
//  guarda distancia al de adelante (car-following) y se recalcula
//  su propia ruta si queda atascado.
// ════════════════════════════════════════════════════════════════

// Margen de tolerancia entre la posición (Float32Array, precisión reducida) y las
// longitudes de tramo (calculadas en float64 cada frame) — ver el comentario en _stepAgent.
const SEG_EPS = 0.01

export const AGENT_STATE = { MOVING: 0, WAITING: 1, STUCK: 2, ARRIVED: 3 }
const STATE_COLOR = {
  [AGENT_STATE.MOVING]: new THREE.Color(0x3b82f6),
  [AGENT_STATE.WAITING]: new THREE.Color(0xfbbf24),
  [AGENT_STATE.STUCK]: new THREE.Color(0xf87171),
  [AGENT_STATE.ARRIVED]: new THREE.Color(0x34d399),
}

// ── Caché de rutas O→D. Casi todos los avatares comparten origen/destino,
//    así que la inmensa mayoría reusa la misma ruta sin tocar Dijkstra. ──
const routeCache = new Map()

// Gancho de Fase 3: la analítica por zonas dirá si una ruta cruza una zona roja.
// Sin zonas activas todavía, la caché siempre se da por válida.
let redZoneChecker = () => false
export function setRedZoneChecker(fn) { redZoneChecker = fn }

// Gancho de Fase 3: invalida las rutas cacheadas que pasan por los nodos de una zona roja
export function invalidateRoutesThroughZone(nodeIds) {
  const affected = new Set(nodeIds)
  for (const [key, path] of routeCache) if (path.some(n => affected.has(n))) routeCache.delete(key)
}

// Se llama al desmontar la simulación: evita que la ruta O→D de una sesión anterior
// (calculada bajo bloqueos/penalizaciones que ya no existen) se reuse en la siguiente.
export function clearRouteCache() { routeCache.clear() }

function getCachedRoute(originId, destId) {
  const key = `${originId}|${destId}`
  const cached = routeCache.get(key)
  if (cached && !redZoneChecker(cached)) return cached
  const path = dijkstra(originId, destId)
  if (path) routeCache.set(key, path)
  return path
}

function edgeKind(aId, bId) {
  for (const e of (GRAPH[aId] || [])) if (e.to === bId) return e.kind
  return null
}
// Eje de circulación de cada tramo de la ruta: 'carrera' = Norte-Sur, 'calle' = Este-Oeste,
// diagonal = sin semáforo que la controle (atajo).
function computeAxes(path) {
  const axes = new Array(path.length - 1)
  for (let k = 0; k < path.length - 1; k++) {
    const kind = edgeKind(path[k], path[k + 1])
    axes[k] = kind === 'carrera' ? 'NS' : kind === 'calle' ? 'EW' : null
  }
  return axes
}

export class AgentSystem {
  constructor(scene, { total, originId, destId, traffic }) {
    this.scene = scene
    this.total = Math.max(1, Math.min(SIM_CONFIG.MAX_AGENTS, total))
    this.originId = originId
    this.destId = destId
    this.traffic = traffic

    this.simTime = 0
    this.spawned = 0
    this.spawnTimerMs = 0
    this.arrivedCount = 0
    this.rerouteCount = 0
    this.rerouteByReason = { atascado: 0, zona_roja: 0 }
    this._kafkaSampleTimer = 0
    // Aristas con avatares circulando ahora mismo → nº de avatares sobre cada una.
    // La Fase 3 la usa para poner incidentes donde hay más tráfico (más realista y
    // concentra la congestión, en vez de repartir incidentes por todo el mapa)
    this.occupiedEdges = new Map()

    // ── Un solo InstancedMesh para los 500 avatares (1 draw call) ──
    // Material sin luces (Basic) para que el color de estado se vea siempre nítido
    // desde arriba, sin depender del ángulo de la luz — clave para distinguirlos a escala de ciudad.
    const geo = new THREE.BoxGeometry(1.3, 1.1, 2.4)
    const mat = new THREE.MeshBasicMaterial()
    this.mesh = new THREE.InstancedMesh(geo, mat, this.total)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false   // las instancias se mueven todo el tiempo: no recortar por bounding stale
    scene.add(this.mesh)

    // ── Struct of Arrays: estado de cada avatar (nada de objetos por avatar) ──
    const n = this.total
    this.active = new Uint8Array(n)
    this.state = new Uint8Array(n)
    this.pathNodes = new Array(n)   // ruta (ids de nodo) — largo variable, no cabe en typed array
    this.pathAxis = new Array(n)    // eje NS/EW/null por tramo de la ruta
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
  }

  // ── Ciclo principal: llamado una vez por frame desde la Vista 3 ──
  update(dt, simTime) {
    this.simTime = simTime
    this._trySpawn(dt)

    // Pase 1: agrupar avatares por (tramo actual + carril) para car-following barato
    // (evita comparar cada avatar contra todos los demás → O(n) en vez de O(n²))
    const groups = this._groups
    groups.clear()
    this.occupiedEdges.clear()
    for (let i = 0; i < this.total; i++) {
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
    for (let i = 0; i < this.total; i++) {
      if (!this.active[i]) continue
      if (this.state[i] === AGENT_STATE.ARRIVED) continue
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

  // ── Salida escalonada: un avatar nuevo cada SPAWN_INTERVAL_MS ──
  _trySpawn(dt) {
    if (this.spawned >= this.total) return
    this.spawnTimerMs += dt * 1000
    while (this.spawnTimerMs >= SIM_CONFIG.SPAWN_INTERVAL_MS && this.spawned < this.total) {
      this.spawnTimerMs -= SIM_CONFIG.SPAWN_INTERVAL_MS
      // Si no hay ruta disponible AHORA (p.ej. incidentes/zonas rojas bloquean todo el
      // entorno del origen), el cupo NO se consume: se reintenta en el siguiente ciclo
      // de spawn en vez de perder ese avatar para siempre (y dejar `spawned` sin poder
      // alcanzar `total`, lo que habría colgado el fin-de-simulación automático).
      if (this._spawnOne(this.spawned)) this.spawned++
    }
  }

  // Devuelve true si el avatar quedó activo (o llegó de inmediato); false si no hay
  // ruta disponible todavía y hay que reintentar en el próximo ciclo de spawn.
  _spawnOne(i) {
    const path = getCachedRoute(this.originId, this.destId)
    if (!path || path.length < 1) return false   // origen y destino totalmente incomunicados ahora mismo

    this.active[i] = 1
    this.pathNodes[i] = path
    this.pathAxis[i] = computeAxes(path)
    this.segIndex[i] = 0
    this.segDist[i] = 0
    this.lane[i] = Math.random() < 0.5 ? 0 : 1
    this.speed[i] = 0
    this.speedFactor[i] = 0.85 + Math.random() * 0.3
    this.distTraveled[i] = 0
    this.spawnTime[i] = this.simTime
    this.stuckTimer[i] = 0
    this.stuckAccum[i] = 0

    const n0 = NODES[path[0]]
    this.posX[i] = n0.x; this.posZ[i] = n0.z
    this.lastCheckX[i] = n0.x; this.lastCheckZ[i] = n0.z

    kafka.send('agent.spawn', { agent_id: i, origin: this.originId, dest: this.destId, ts: Date.now() })

    // Origen === destino (caso borde; la Vista 2 ya lo impide, pero se maneja igual):
    // ruta de un solo nodo, el avatar "llega" en el mismo instante que sale.
    if (path.length === 1) { this._arrive(i); return true }

    this.state[i] = AGENT_STATE.MOVING
    return true
  }

  // ── Avance de un avatar: semáforo → car-following → interpolación → atasco ──
  _stepAgent(i, dt, groups) {
    const path = this.pathNodes[i]
    let idx = this.segIndex[i]
    if (idx >= path.length - 1) { this._arrive(i); return }

    const a = NODES[path[idx]], b = NODES[path[idx + 1]]
    const dx = b.x - a.x, dz = b.z - a.z
    const segLen = Math.hypot(dx, dz)

    // Semáforo: solo se evalúa cerca del nodo, y no en el último tramo (para no
    // dejar avatares "congelados" justo al llegar a su destino)
    let mustStop = false
    if (idx < path.length - 2 && segLen - this.segDist[i] < SIM_CONFIG.STOP_DISTANCE) {
      const axis = this.pathAxis[i][idx]
      if (axis && !this.traffic.isGreenForAxis(path[idx + 1], axis)) mustStop = true
    }

    // Car-following: no puedo pasar al que tengo delante en mi mismo tramo+carril
    const key = `${path[idx]}>${path[idx + 1]}_${this.lane[i]}`
    const group = groups.get(key)
    let maxSegDist = segLen
    if (group) {
      const pos = group.indexOf(i)
      if (pos > 0) maxSegDist = Math.min(segLen, this.segDist[group[pos - 1]] - SIM_CONFIG.MIN_GAP)
    }

    const targetSpeed = mustStop ? 0 : SIM_CONFIG.AGENT_SPEED * this.speedFactor[i]
    this.speed[i] += (targetSpeed - this.speed[i]) * Math.min(1, dt * 4)
    if (this.speed[i] < 0) this.speed[i] = 0

    let newSegDist = this.segDist[i] + this.speed[i] * dt
    this.segDist[i] = Math.max(0, Math.min(newSegDist, maxSegDist))

    if (this.state[i] !== AGENT_STATE.STUCK) {
      this.state[i] = mustStop ? AGENT_STATE.WAITING : AGENT_STATE.MOVING
    }

    // Avanza de tramo si completó el actual (nunca el último, ese lo cierra _arrive).
    // SEG_EPS: segDist vive en un Float32Array (precisión reducida) pero segLen se calcula
    // en float64 cada frame; sin este margen, un avatar sin líder por delante queda clavado
    // para siempre justo en el borde del tramo (segDist queda redondeado a un pelo menos que
    // segLen y nunca cumple segDist < len), y todos detrás de él heredan el atasco eterno.
    while (this.segIndex[i] < path.length - 2) {
      const ii = this.segIndex[i]
      const na = NODES[path[ii]], nb = NODES[path[ii + 1]]
      const len = Math.hypot(nb.x - na.x, nb.z - na.z)
      if (this.segDist[i] < len - SEG_EPS) break
      this.segDist[i] = Math.max(0, this.segDist[i] - len)
      this.segIndex[i]++
      this.distTraveled[i] += len
    }
    idx = this.segIndex[i]
    const na = NODES[path[idx]], nb = NODES[path[idx + 1]]
    const dx2 = nb.x - na.x, dz2 = nb.z - na.z, len2 = Math.hypot(dx2, dz2) || 1
    if (idx >= path.length - 2 && this.segDist[i] >= len2 - SEG_EPS) { this._arrive(i); return }

    const t = this.segDist[i] / len2
    const px = na.x + dx2 * t, pz = na.z + dz2 * t
    // Offset de carril: perpendicular "derecha" respecto al sentido de avance (norte arriba, -z = norte)
    const perpX = -dz2 / len2, perpZ = dx2 / len2
    const laneOffset = SIM_CONFIG.LANE_OFFSET * (0.5 + this.lane[i])
    this.posX[i] = px + perpX * laneOffset
    this.posZ[i] = pz + perpZ * laneOffset
    this.heading[i] = Math.atan2(dx2, dz2)

    // Atasco: solo cuenta si NO está parado legítimamente en un semáforo en rojo
    if (mustStop) { this.stuckTimer[i] = 0; this.stuckAccum[i] = 0; return }
    this.stuckTimer[i] += dt
    if (this.stuckTimer[i] < 1) return
    const moved = Math.hypot(this.posX[i] - this.lastCheckX[i], this.posZ[i] - this.lastCheckZ[i])
    if (moved < 0.15) {
      this.stuckAccum[i] += this.stuckTimer[i]
      // Sin el guard "state !== STUCK": _triggerReroute ya resetea stuckAccum siempre
      // (éxito o fracaso), así que este umbral por sí solo evita reintentos en bucle. Si
      // SÍ se dejara ese guard, un avatar cuyo primer reintento falla (p.ej. con todas las
      // rutas bloqueadas) quedaría en STUCK para siempre, sin volver a reintentar nunca
      // — ni cuando el bloqueo se libere más tarde.
      if (this.stuckAccum[i] >= SIM_CONFIG.STUCK_TIME) {
        this._triggerReroute(i, 'atascado')
      }
    } else {
      this.stuckAccum[i] = 0
    }
    this.lastCheckX[i] = this.posX[i]; this.lastCheckZ[i] = this.posZ[i]
    this.stuckTimer[i] = 0
  }

  // ── Reroute individual: NO usa/escribe la caché global, es la ruta propia de este avatar ──
  // motivo: 'atascado' (detectado por este mismo avatar) | 'zona_roja' (forzado por analítica)
  _triggerReroute(i, motivo) {
    if (motivo === 'atascado') this.state[i] = AGENT_STATE.STUCK   // flash rojo visible solo en atasco real
    const path = this.pathNodes[i]
    const fromNode = path[this.segIndex[i] + 1] ?? path[this.segIndex[i]]
    const newTail = dijkstra(fromNode, this.destId)
    this.rerouteCount++
    this.rerouteByReason[motivo] = (this.rerouteByReason[motivo] || 0) + 1
    kafka.send('agent.reroute', { agent_id: i, motivo, ts: Date.now() })
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

  // ── Gancho de Fase 3: cuando una zona se pone roja, desvía también a los avatares
  //    que YA están en camino y cuya ruta restante pasa por esa zona (no solo a los nuevos) ──
  rerouteAgentsThroughZone(zoneNodeIds) {
    const set = zoneNodeIds instanceof Set ? zoneNodeIds : new Set(zoneNodeIds)
    for (let i = 0; i < this.total; i++) {
      if (!this.active[i] || this.state[i] === AGENT_STATE.ARRIVED) continue
      const path = this.pathNodes[i]
      let crosses = false
      for (let k = this.segIndex[i] + 1; k < path.length; k++) {
        if (set.has(path[k])) { crosses = true; break }
      }
      if (crosses) this._triggerReroute(i, 'zona_roja')
    }
  }

  _arrive(i) {
    this.state[i] = AGENT_STATE.ARRIVED
    this.arriveTime[i] = this.simTime
    this.arrivedCount++
    const dest = NODES[this.pathNodes[i][this.pathNodes[i].length - 1]]
    this.posX[i] = dest.x; this.posZ[i] = dest.z
    kafka.send('agent.arrived', {
      agent_id: i,
      travel_time_s: +(this.simTime - this.spawnTime[i]).toFixed(1),
      distance_m: +(this.distTraveled[i] * UNIT_TO_METERS).toFixed(1),
    })
  }

  // ── Vuelca posición/color de cada avatar en el InstancedMesh ──
  _writeInstances() {
    for (let i = 0; i < this.total; i++) {
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
    for (let i = 0; i < this.total; i++) {
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
    clearRouteCache()
  }
}

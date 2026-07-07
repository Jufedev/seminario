import * as THREE from 'three'
import { NODES, MAP_BOUNDS, setEdgePenalty, allEdges, DEFAULT_EDGE_STATE } from '../graph/mapData.js'
import { SIM_CONFIG } from '../sim/config.js'
import { kafka } from '../kafka/producer.js'
import { ANALYTICS_CONFIG as CFG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  ANALÍTICA POR ZONAS — el corazón del BigData del proyecto.
//  El mapa se divide en una cuadrícula GRID_SIZE×GRID_SIZE. Cada
//  ~1s (ventana, NO cada frame) se recalcula por zona:
//
//   ρ (densidad)        = avatares_en_zona / capacidad_zona        (capacidad = nAristas · factor)
//   incidentes          = incidentes_en_zona / nAristas_zona
//   déficit_velocidad   = 1 − (velocidad_media_zona / velocidad_libre)
//   C = W_DENSITY·ρ + W_INCIDENTS·incidentes + W_SPEED_DEFICIT·déficit      (0..1)
//
//  Si C ≥ C_RED_THRESHOLD → zona ROJA: se penalizan sus aristas para Dijkstra
//  (proporcional a C) y se invalida la caché de rutas que pasan por ahí, para
//  que los siguientes avatares (y los que ya van en camino) la eviten.
// ════════════════════════════════════════════════════════════════
export class ZoneSystem {
  // headless: en el servidor no hay overlay 3D (los clientes pintan desde el snapshot);
  // graphState: penalizaciones sobre el estado de la sala, no el global compartido.
  constructor(scene, { agentSystem, incidentManager, headless = false, graphState = DEFAULT_EDGE_STATE }) {
    this.scene = scene
    this.agentSystem = agentSystem
    this.incidentManager = incidentManager
    this.headless = headless
    this.graphState = graphState

    this.cfg = CFG   // expuesto para lectura/depuración en vivo (window.__DEBUG_SIM.zoneSystem.cfg)
    const n = CFG.GRID_SIZE * CFG.GRID_SIZE
    this.n = n
    this.C = new Float32Array(n)
    this.density = new Float32Array(n)
    this.incidentsNorm = new Float32Array(n)
    this.speedDeficit = new Float32Array(n)
    this.isRed = new Uint8Array(n)
    this.cSum = new Float64Array(n)     // acumulado histórico de C, para el promedio por zona
    this.sampleCount = new Uint32Array(n)
    this._curOpacity = new Float32Array(n)

    this._buildZoneEdges()
    if (!this.headless) this._buildOverlay()
    this._acc = 0
    this._redNodeIds = new Set()

    // Conecta esta analítica con el motor de avatares (caché de rutas por instancia)
    this.agentSystem.setRedZoneChecker(path => path.some(nodeId => this._redNodeIds.has(nodeId)))
  }

  // ── Índice de zona a partir de coordenadas de mundo (x,z) ──
  zoneIndexAt(x, z) {
    const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
    const cw = (xMax - xMin) / CFG.GRID_SIZE, ch = (zMax - zMin) / CFG.GRID_SIZE
    let zx = Math.floor((x - xMin) / cw), zz = Math.floor((z - zMin) / ch)
    zx = Math.max(0, Math.min(CFG.GRID_SIZE - 1, zx))
    zz = Math.max(0, Math.min(CFG.GRID_SIZE - 1, zz))
    return zz * CFG.GRID_SIZE + zx
  }

  // ── Asigna cada arista del grafo a la zona donde cae su punto medio (una sola vez) ──
  _buildZoneEdges() {
    this.zoneEdges = Array.from({ length: this.n }, () => [])
    this.zoneNodeIds = Array.from({ length: this.n }, () => new Set())
    this.capacity = new Float32Array(this.n)
    for (const { a, b } of allEdges()) {
      const na = NODES[a], nb = NODES[b]
      const idx = this.zoneIndexAt((na.x + nb.x) / 2, (na.z + nb.z) / 2)
      this.zoneEdges[idx].push({ a, b })
      this.zoneNodeIds[idx].add(a).add(b)
    }
    for (let i = 0; i < this.n; i++) this.capacity[i] = Math.max(1, this.zoneEdges[i].length) * CFG.ZONE_CAPACITY_PER_EDGE
  }

  // ── Un plano rojo semitransparente por zona, oculto hasta que la zona se ponga roja ──
  _buildOverlay() {
    const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
    const cw = (xMax - xMin) / CFG.GRID_SIZE, ch = (zMax - zMin) / CFG.GRID_SIZE
    this.planes = []
    for (let zz = 0; zz < CFG.GRID_SIZE; zz++) {
      for (let zx = 0; zx < CFG.GRID_SIZE; zx++) {
        const cx = xMin + (zx + 0.5) * cw, cz = zMin + (zz + 0.5) * ch
        const mat = new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0, depthWrite: false })
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(cw * 0.94, ch * 0.94), mat)
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set(cx, 0.5, cz)
        mesh.visible = false
        this.scene.add(mesh)
        this.planes.push(mesh)
      }
    }
  }

  // ── Ciclo por frame: acumula tiempo, recalcula cada ~1s, y suaviza la opacidad visual ──
  update(dt, simTime) {
    this._acc += dt
    if (this._acc >= CFG.ZONE_WINDOW_S) {
      this._acc = 0
      this._recompute(simTime)
    }
    if (this.headless) return   // sin overlay que animar en el servidor
    for (let i = 0; i < this.n; i++) {
      const target = this.isRed[i] ? 0.12 + 0.45 * this.C[i] : 0
      this._curOpacity[i] += (target - this._curOpacity[i]) * Math.min(1, dt * 3)
      this.planes[i].material.opacity = this._curOpacity[i]
      this.planes[i].visible = this._curOpacity[i] > 0.01
    }
  }

  _recompute(simTime) {
    const as = this.agentSystem
    const counts = new Float32Array(this.n)
    const speedSum = new Float32Array(this.n)
    const speedCount = new Uint32Array(this.n)
    const incCounts = new Float32Array(this.n)

    for (let i = 0; i < as.total; i++) {
      if (!as.active[i] || as.state[i] === 3 /* ARRIVED */) continue
      const idx = this.zoneIndexAt(as.posX[i], as.posZ[i])
      counts[idx]++
      speedSum[idx] += as.speed[i]
      speedCount[idx]++
    }
    for (const inc of this.incidentManager.active) {
      const idx = this.zoneIndexAt(inc.x, inc.z)
      incCounts[idx]++
    }

    const redNodeIds = new Set()
    for (let z = 0; z < this.n; z++) {
      // ρ = avatares / capacidad (capacidad = nAristas · factor), saturada en 1
      const density = Math.min(1, counts[z] / this.capacity[z])
      // incidentes activos / nAristas de la zona, saturado en 1
      const nEdges = Math.max(1, this.zoneEdges[z].length)
      const incidentesNorm = Math.min(1, incCounts[z] / nEdges)
      // déficit de velocidad: sin muestras se asume flujo libre (no penaliza zonas vacías)
      const avgSpeed = speedCount[z] ? speedSum[z] / speedCount[z] : SIM_CONFIG.AGENT_SPEED
      const speedDeficit = Math.max(0, Math.min(1, 1 - avgSpeed / SIM_CONFIG.AGENT_SPEED))

      const C = CFG.W_DENSITY * density + CFG.W_INCIDENTS * incidentesNorm + CFG.W_SPEED_DEFICIT * speedDeficit

      this.density[z] = density
      this.incidentsNorm[z] = incidentesNorm
      this.speedDeficit[z] = speedDeficit
      this.C[z] = C
      this.cSum[z] += C
      this.sampleCount[z]++

      const wasRed = this.isRed[z] === 1
      // Roja por índice C o por la regla directa de aglomeración (> ZONE_RED_AVATARS en la celda)
      const nowRed = C >= CFG.C_RED_THRESHOLD || counts[z] > CFG.ZONE_RED_AVATARS
      if (nowRed && !wasRed) {
        setEdgePenalty2(this.zoneEdges[z], CFG.ZONE_PENALTY_SCALE * C, this.graphState)
        this.agentSystem.invalidateRoutesThroughZone(this.zoneNodeIds[z])
        this.agentSystem.rerouteAgentsThroughZone(this.zoneNodeIds[z])
        kafka.send('zone.red', { zone: z, C: +C.toFixed(2), density: +density.toFixed(2), ts: Date.now() })
      } else if (!nowRed && wasRed) {
        setEdgePenalty2(this.zoneEdges[z], 0, this.graphState)
        kafka.send('zone.clear', { zone: z, ts: Date.now() })
      } else if (nowRed) {
        // sigue roja: actualiza la penalización si C cambió
        setEdgePenalty2(this.zoneEdges[z], CFG.ZONE_PENALTY_SCALE * C, this.graphState)
      }
      this.isRed[z] = nowRed ? 1 : 0
      if (nowRed) for (const id of this.zoneNodeIds[z]) redNodeIds.add(id)
    }
    this._redNodeIds = redNodeIds

    const s = as.getStats()
    kafka.send('analytics.snapshot', {
      active: s.active, arrived: as.arrivedCount, stuck: s.stuck,
      red_zones: this.getRedCount(),
      avg_C: +this.getGlobalCongestionIndex().toFixed(3),
      avg_speed_mps: +s.avgSpeedMps.toFixed(2),
      // C por zona (para el heatmap del consumidor) + máscara de rojas
      zones_C: Array.from(this.C, v => +v.toFixed(3)),
      zones_red: Array.from(this.isRed),
      ts: Date.now(),
    })
  }

  getRedCount() { let c = 0; for (let i = 0; i < this.n; i++) c += this.isRed[i]; return c }

  // Índice de congestión global: promedio de C ponderado por capacidad de cada zona
  getGlobalCongestionIndex() {
    let num = 0, den = 0
    for (let i = 0; i < this.n; i++) { num += this.C[i] * this.capacity[i]; den += this.capacity[i] }
    return den ? num / den : 0
  }

  // Zona con mayor C promedio a lo largo de toda la simulación (no solo el instante actual)
  getMostCongestedZone() {
    let best = -1, bestC = -1
    for (let i = 0; i < this.n; i++) {
      const avg = this.sampleCount[i] ? this.cSum[i] / this.sampleCount[i] : 0
      if (avg > bestC) { bestC = avg; best = i }
    }
    if (best < 0) return null
    return { zone: best, zx: best % CFG.GRID_SIZE, zz: Math.floor(best / CFG.GRID_SIZE), avgC: bestC }
  }

  // Snapshot completo (para el heatmap del dashboard)
  getSnapshot() {
    const out = []
    for (let i = 0; i < this.n; i++) {
      out.push({
        zone: i, zx: i % CFG.GRID_SIZE, zz: Math.floor(i / CFG.GRID_SIZE),
        C: this.C[i], isRed: this.isRed[i] === 1,
        avgC: this.sampleCount[i] ? this.cSum[i] / this.sampleCount[i] : 0,
      })
    }
    return out
  }

  dispose() {
    // Limpia la penalización de cualquier zona que siguiera roja al salir de la vista
    // (mismo motivo que IncidentManager.dispose() — no dejar basura en el grafo compartido)
    for (let z = 0; z < this.n; z++) if (this.isRed[z]) setEdgePenalty2(this.zoneEdges[z], 0, this.graphState)
    this.planes?.forEach(p => { p.geometry.dispose(); p.material.dispose(); p.removeFromParent() })
  }
}

function setEdgePenalty2(edges, penalty, state) {
  for (const e of edges) setEdgePenalty(e.a, e.b, penalty, state)
}

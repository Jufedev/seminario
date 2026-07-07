import * as THREE from 'three'
import { NODES, setEdgeBlocked, DEFAULT_EDGE_STATE } from '../graph/mapData.js'
import { kafka } from '../kafka/producer.js'
import { SIM_CONFIG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  INCIDENTES — bloquean un tramo del grafo por un tiempo limitado.
//  4 tipos con colores MUY distintos; la obra lleva rayas de peligro.
//  Al nacer un incidente:
//   1. la arista queda bloqueada (nadie la cruza),
//   2. se invalida la caché de rutas que la usaban,
//   3. los avatares en camino cuya ruta la usaba recalculan YA.
//  M3: modo `headless` para el servidor (sin mallas ni document);
//  los clientes dibujan los marcadores desde el world_snapshot con
//  createIncidentMarker() — el mismo visual en offline y online.
// ════════════════════════════════════════════════════════════════
const TYPES = [
  { id: 'accidente',     label: 'Accidente',       color: 0xe11d48 },                 // rojo intenso
  { id: 'obra',          label: 'Obra en la vía',  color: 0xf59e0b, striped: true },  // naranja con rayas
  { id: 'manifestacion', label: 'Manifestación',   color: 0x9333ea },                 // morado
  { id: 'varado',        label: 'Vehículo varado', color: 0x0891b2 },                 // azul/cian
]

function rnd(a, b) { return a + Math.random() * (b - a) }

// Textura de rayas diagonales tipo "obra en la vía" (solo cliente; cache module-level)
let stripeTex = null
function makeStripeTexture(colorHex) {
  const cnv = document.createElement('canvas')
  cnv.width = cnv.height = 64
  const c = cnv.getContext('2d')
  c.fillStyle = '#' + colorHex.toString(16).padStart(6, '0')
  c.fillRect(0, 0, 64, 64)
  c.strokeStyle = 'rgba(20,14,4,0.9)'
  c.lineWidth = 9
  for (let k = -64; k <= 128; k += 22) {
    c.beginPath(); c.moveTo(k, 68); c.lineTo(k + 68, -4); c.stroke()
  }
  const tex = new THREE.CanvasTexture(cnv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

// Marcador sobre la vía: disco del color del tipo (rayado si es obra) + poste con
// "luz" del mismo color para verse también en 3D. Usado por el modo offline y por
// la vista online (que lo crea a partir del snapshot del servidor).
export function createIncidentMarker(type) {
  const discMat = type.striped
    ? new THREE.MeshBasicMaterial({ map: (stripeTex ||= makeStripeTexture(type.color)), transparent: true, opacity: 0.95 })
    : new THREE.MeshBasicMaterial({ color: type.color, transparent: true, opacity: 0.95 })
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.5, 18), discMat)
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.28, 3.4, 8),
    new THREE.MeshBasicMaterial({ color: 0x1c2430 })
  )
  post.position.y = 1.9
  mesh.add(post)
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 10),
    new THREE.MeshBasicMaterial({ color: type.color })
  )
  light.position.y = 3.9
  mesh.add(light)
  return mesh
}

export class IncidentManager {
  constructor(scene, { agentSystem, graphEdges, frequencySec, headless = false, graphState = DEFAULT_EDGE_STATE }) {
    this.scene = scene
    this.agentSystem = agentSystem
    this.graphEdges = graphEdges          // lista [{a,b}] de TODAS las aristas (fallback si nada ocupado)
    this.frequencySec = frequencySec
    this.headless = headless              // servidor: sin mallas (el cliente dibuja del snapshot)
    this.graphState = graphState
    this.active = []                       // incidentes vivos: {id,typeIndex,type,edge,x,z,start,duration,mesh?}
    this.typeCounts = {}                   // conteo acumulado por tipo (para el dashboard)
    TYPES.forEach(t => (this.typeCounts[t.id] = 0))
    this._nextId = 1
    this._spawnTimer = this._randomInterval()
  }

  _randomInterval() {
    // Llegadas escalonadas alrededor de la frecuencia configurada (± 50%), no fijas
    return rnd(this.frequencySec * 0.5, this.frequencySec * 1.5)
  }

  setFrequency(sec) {
    this.frequencySec = sec
    // efecto inmediato al bajar la frecuencia: no esperar el temporizador viejo
    this._spawnTimer = Math.min(this._spawnTimer, this._randomInterval())
  }

  update(dt, simTime) {
    this._spawnTimer -= dt
    if (this._spawnTimer <= 0) {
      this._spawnTimer = this._randomInterval()
      this._spawnOne(simTime)
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const inc = this.active[i]
      if (simTime - inc.start >= inc.duration) this._expire(i, simTime)
    }
  }

  // Elige al azar entre las aristas MÁS cargadas sin incidente activo (top 8).
  // Realista: los incidentes aparecen donde hay tráfico, pero no siempre en el
  // mismo punto — se reparten a lo largo de las rutas concurridas.
  _pickEdge() {
    const occ = this.agentSystem.occupiedEdges
    if (!occ || !occ.size) {
      if (!this.graphEdges.length) return null
      return this.graphEdges[Math.floor(Math.random() * this.graphEdges.length)]
    }
    const sorted = [...occ.entries()].sort((x, y) => y[1] - x[1])
    const candidates = []
    for (const [k] of sorted) {
      const [a, b] = k.split('|')
      const taken = this.active.some(inc => (inc.edge.a === a && inc.edge.b === b) || (inc.edge.a === b && inc.edge.b === a))
      if (!taken) candidates.push({ a, b })
      if (candidates.length >= 8) break
    }
    if (!candidates.length) return null
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  _spawnOne(simTime) {
    if (this.active.length >= SIM_CONFIG.INCIDENT_MAX_ACTIVE) return
    const edge = this._pickEdge()
    if (!edge) return
    const typeIndex = Math.floor(Math.random() * TYPES.length)
    const type = TYPES[typeIndex]
    const na = NODES[edge.a], nb = NODES[edge.b]
    const x = (na.x + nb.x) / 2, z = (na.z + nb.z) / 2
    const duration = rnd(SIM_CONFIG.INCIDENT_MIN_S, SIM_CONFIG.INCIDENT_MAX_S)

    let mesh = null
    if (!this.headless) {
      mesh = createIncidentMarker(type)
      mesh.position.set(x, 0.6, z)
      this.scene.add(mesh)
    }

    const inc = { id: this._nextId++, typeIndex, type, edge, x, z, start: simTime, duration, mesh }
    this.active.push(inc)
    this.typeCounts[type.id]++

    // Bloqueo real: nadie cruza + rutas cacheadas fuera + los que iban a pasar recalculan
    setEdgeBlocked(edge.a, edge.b, true, this.graphState)
    this.agentSystem.invalidateRoutesThroughEdge(edge.a, edge.b)
    this.agentSystem.rerouteAgentsThroughEdge(edge.a, edge.b)

    kafka.send('incident.start', { incident_id: inc.id, type: type.id, edge: [edge.a, edge.b], duration_s: +duration.toFixed(1), ts: Date.now() })
  }

  _expire(i, simTime) {
    const inc = this.active[i]
    setEdgeBlocked(inc.edge.a, inc.edge.b, false, this.graphState)
    if (inc.mesh) {
      this.scene.remove(inc.mesh)
      inc.mesh.geometry.dispose(); inc.mesh.material.dispose()
    }
    kafka.send('incident.end', { incident_id: inc.id, ts: Date.now() })
    this.active.splice(i, 1)
  }

  getActiveCount() { return this.active.length }

  // Lista compacta para el world_snapshot del servidor: [id, typeIndex, x, z] × incidente
  snapshotFlat() {
    const out = []
    for (const inc of this.active) out.push(inc.id, inc.typeIndex, Math.round(inc.x * 100) / 100, Math.round(inc.z * 100) / 100)
    return out
  }

  // Elimina todos los incidentes activos YA (admin_control reset), desbloqueando sus aristas
  clearAll() {
    this.active.forEach(inc => {
      setEdgeBlocked(inc.edge.a, inc.edge.b, false, this.graphState)
      if (inc.mesh) { this.scene.remove(inc.mesh); inc.mesh.geometry.dispose(); inc.mesh.material.dispose() }
    })
    this.active.length = 0
    this._spawnTimer = this._randomInterval()
  }

  dispose() {
    // Desbloquea las aristas de los incidentes que seguían activos al salir de la vista
    // (si no, quedarían cerradas para siempre en el estado compartido del offline)
    this.clearAll()
  }
}

export { TYPES as INCIDENT_TYPES }

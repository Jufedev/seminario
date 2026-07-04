import * as THREE from 'three'
import { NODES, setEdgeBlocked } from '../graph/mapData.js'
import { kafka } from '../kafka/producer.js'
import { SIM_CONFIG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  INCIDENTES — bloquean un tramo del grafo por un tiempo limitado.
//  Aparecen sobre aristas con avatares circulando (más relevante para
//  la analítica) y se marcan con un disco de color simple, sin
//  geometría pesada.
// ════════════════════════════════════════════════════════════════
const TYPES = [
  { id: 'accidente',      label: 'Accidente',           color: 0xe66767 },
  { id: 'obra',            label: 'Obra en la vía',      color: 0xc98500 },
  { id: 'manifestacion',   label: 'Manifestación',       color: 0x9085e9 },
  { id: 'varado',          label: 'Vehículo varado',     color: 0xd55181 },
]

function rnd(a, b) { return a + Math.random() * (b - a) }

export class IncidentManager {
  constructor(scene, { agentSystem, graphEdges, frequencySec }) {
    this.scene = scene
    this.agentSystem = agentSystem
    this.graphEdges = graphEdges          // lista [{a,b}] de TODAS las aristas (fallback si nada ocupado)
    this.frequencySec = frequencySec
    this.active = []                       // incidentes vivos: {id,type,edge,x,z,start,duration,mesh}
    this.typeCounts = {}                   // conteo acumulado por tipo (para el dashboard)
    TYPES.forEach(t => (this.typeCounts[t.id] = 0))
    this._nextId = 1
    this._spawnTimer = this._randomInterval()
  }

  _randomInterval() {
    // Llegadas escalonadas alrededor de la frecuencia configurada (± 50%), no fijas
    return rnd(this.frequencySec * 0.5, this.frequencySec * 1.5)
  }

  setFrequency(sec) { this.frequencySec = sec }

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

  // Elige la arista más cargada de todo el mapa que no tenga ya un incidente activo
  // (realista: los incidentes se concentran donde hay más tráfico, en vez de repartirse
  // uniformemente — esto es lo que permite que una zona acumule suficientes incidentes
  // simultáneos como para que el índice de congestión C detecte el punto crítico real).
  _pickEdge() {
    const occ = this.agentSystem.occupiedEdges
    if (!occ || !occ.size) {
      // Aún no hay tráfico (arranque de la simulación): cualquier arista del grafo
      if (!this.graphEdges.length) return null
      return this.graphEdges[Math.floor(Math.random() * this.graphEdges.length)]
    }
    const sorted = [...occ.entries()].sort((x, y) => y[1] - x[1])
    for (const [k] of sorted) {
      const [a, b] = k.split('|')
      const blocked = this.active.some(inc => (inc.edge.a === a && inc.edge.b === b) || (inc.edge.a === b && inc.edge.b === a))
      if (!blocked) return { a, b }
    }
    return null
  }

  _spawnOne(simTime) {
    if (this.active.length >= SIM_CONFIG.INCIDENT_MAX_ACTIVE) return
    const edge = this._pickEdge()
    if (!edge) return
    const type = TYPES[Math.floor(Math.random() * TYPES.length)]
    const na = NODES[edge.a], nb = NODES[edge.b]
    const x = (na.x + nb.x) / 2, z = (na.z + nb.z) / 2
    const duration = rnd(SIM_CONFIG.INCIDENT_MIN_S, SIM_CONFIG.INCIDENT_MAX_S)

    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 2.4, 0.5, 16),
      new THREE.MeshBasicMaterial({ color: type.color, transparent: true, opacity: 0.92 })
    )
    mesh.position.set(x, 0.6, z)
    this.scene.add(mesh)
    // Cono de aviso simple encima, para que se note incluso en 2D cenital
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.6, 8), new THREE.MeshBasicMaterial({ color: 0xffd21e }))
    cone.position.y = 1.3
    mesh.add(cone)

    const inc = { id: this._nextId++, type, edge, x, z, start: simTime, duration, mesh }
    this.active.push(inc)
    this.typeCounts[type.id]++
    setEdgeBlocked(edge.a, edge.b, true)

    kafka.send('incident.start', { incident_id: inc.id, type: type.id, edge: [edge.a, edge.b], duration_s: +duration.toFixed(1), ts: Date.now() })
  }

  _expire(i, simTime) {
    const inc = this.active[i]
    setEdgeBlocked(inc.edge.a, inc.edge.b, false)
    this.scene.remove(inc.mesh)
    inc.mesh.geometry.dispose(); inc.mesh.material.dispose()
    kafka.send('incident.end', { incident_id: inc.id, ts: Date.now() })
    this.active.splice(i, 1)
  }

  getActiveCount() { return this.active.length }

  dispose() {
    // Desbloquea las aristas de los incidentes que seguían activos al salir de la vista
    // (si no, quedarían cerradas para siempre en el grafo compartido — ver resetGraph())
    this.active.forEach(inc => {
      setEdgeBlocked(inc.edge.a, inc.edge.b, false)
      this.scene.remove(inc.mesh); inc.mesh.geometry.dispose(); inc.mesh.material.dispose()
    })
    this.active.length = 0
  }
}

export { TYPES as INCIDENT_TYPES }

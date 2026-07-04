import * as THREE from 'three'
import { NODES } from '../graph/mapData.js'
import { SIM_CONFIG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  SEMÁFOROS — TODOS sincronizados: cambian de fase juntos cada
//  LIGHT_PERIOD segundos. Fase A = verde Norte-Sur (carreras),
//  fase B = verde Este-Oeste (calles). Un único InstancedMesh dibuja
//  el indicador de cada intersección.
// ════════════════════════════════════════════════════════════════
export class TrafficSystem {
  constructor(scene) {
    this.elapsed = 0
    this.phase = 'A'
    this._greenColor = new THREE.Color(0x34d399)
    this._redColor = new THREE.Color(0xf87171)
    this._buildIndicators(scene)
  }

  _buildIndicators(scene) {
    this.nodeIds = Object.keys(NODES)
    const geo = new THREE.SphereGeometry(1.1, 8, 8)
    const mat = new THREE.MeshBasicMaterial()
    this.mesh = new THREE.InstancedMesh(geo, mat, this.nodeIds.length)
    this.mesh.frustumCulled = false
    const m = new THREE.Matrix4()
    this.nodeIds.forEach((id, i) => {
      const n = NODES[id]
      m.makeTranslation(n.x, 5, n.z)
      this.mesh.setMatrixAt(i, m)
      this.mesh.setColorAt(i, this._greenColor)
    })
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
    scene.add(this.mesh)
  }

  // Solo se reescribe el color de los indicadores cuando cambia la fase (no cada frame)
  update(dt) {
    this.elapsed += dt
    const phase = Math.floor(this.elapsed / SIM_CONFIG.LIGHT_PERIOD) % 2 === 0 ? 'A' : 'B'
    if (phase === this.phase) return
    this.phase = phase
    const color = phase === 'A' ? this._greenColor : this._redColor
    for (let i = 0; i < this.nodeIds.length; i++) this.mesh.setColorAt(i, color)
    this.mesh.instanceColor.needsUpdate = true
  }

  // ¿El eje dado tiene verde en este instante? (todas las intersecciones sincronizadas hoy;
  // el parámetro nodeId se deja listo para que la Fase 3 pueda desincronizar por zona)
  isGreenForAxis(nodeId, axis) {
    return (axis === 'NS' && this.phase === 'A') || (axis === 'EW' && this.phase === 'B')
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.removeFromParent()
  }
}

import * as THREE from 'three'
import { NODES } from '../graph/mapData.js'
import { SIM_CONFIG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  SEMÁFOROS — alternados por eje y desincronizados por cruce.
//  En cada intersección: carreras (NS) en verde ⇒ calles (EW) en rojo,
//  y viceversa. El desfase es un tablero de ajedrez sobre (ci+ri):
//  la mitad de los cruces da verde a NS mientras la otra mitad da
//  verde a EW, así el tráfico nunca se detiene todo a la vez.
//  Visual: 2 barras por cruce (una por eje) en dos InstancedMesh.
// ════════════════════════════════════════════════════════════════
export class TrafficSystem {
  constructor(scene) {
    this.elapsed = 0
    this.phaseIndex = -1                 // fuerza el primer repintado en update()
    this._green = new THREE.Color(0x22c55e)
    this._red = new THREE.Color(0xef4444)
    this._buildIndicators(scene)
    this.update(0)
  }

  _buildIndicators(scene) {
    this.nodeIds = Object.keys(NODES)
    const n = this.nodeIds.length
    // Barra NS: alargada en Z (sentido de las carreras). Barra EW: alargada en X.
    const geoNS = new THREE.BoxGeometry(0.9, 0.9, 3.6)
    const geoEW = new THREE.BoxGeometry(3.6, 0.9, 0.9)
    const mat = new THREE.MeshBasicMaterial()
    this.meshNS = new THREE.InstancedMesh(geoNS, mat, n)
    this.meshEW = new THREE.InstancedMesh(geoEW, mat.clone(), n)
    this.meshNS.frustumCulled = false
    this.meshEW.frustumCulled = false
    const m = new THREE.Matrix4()
    this.nodeIds.forEach((id, i) => {
      const node = NODES[id]
      m.makeTranslation(node.x, 5, node.z)
      this.meshNS.setMatrixAt(i, m)
      this.meshEW.setMatrixAt(i, m)
      this.meshNS.setColorAt(i, this._green)
      this.meshEW.setColorAt(i, this._red)
    })
    this.meshNS.instanceMatrix.needsUpdate = true
    this.meshEW.instanceMatrix.needsUpdate = true
    scene.add(this.meshNS, this.meshEW)
  }

  // Modo local: la fase avanza con el reloj propio
  update(dt) {
    this.elapsed += dt
    this.setPhaseIndex(Math.floor(this.elapsed / SIM_CONFIG.LIGHT_PERIOD))
  }

  // Fija la fase global directamente (modo online: la fase viene del servidor).
  // Colores solo se reescriben cuando la fase cambia (no cada frame).
  setPhaseIndex(phaseIndex) {
    if (phaseIndex === this.phaseIndex) return
    this.phaseIndex = phaseIndex
    for (let i = 0; i < this.nodeIds.length; i++) {
      const node = NODES[this.nodeIds[i]]
      const greenNS = (node.ci + node.ri + phaseIndex) % 2 === 0
      this.meshNS.setColorAt(i, greenNS ? this._green : this._red)
      this.meshEW.setColorAt(i, greenNS ? this._red : this._green)
    }
    this.meshNS.instanceColor.needsUpdate = true
    this.meshEW.instanceColor.needsUpdate = true
  }

  // ¿El eje dado tiene verde en este cruce ahora mismo? (tablero de ajedrez por (ci+ri))
  isGreenForAxis(nodeId, axis) {
    const node = NODES[nodeId]
    if (!node) return true
    const greenNS = (node.ci + node.ri + this.phaseIndex) % 2 === 0
    return axis === 'NS' ? greenNS : !greenNS
  }

  dispose() {
    this.meshNS.geometry.dispose(); this.meshNS.material.dispose(); this.meshNS.removeFromParent()
    this.meshEW.geometry.dispose(); this.meshEW.material.dispose(); this.meshEW.removeFromParent()
  }
}

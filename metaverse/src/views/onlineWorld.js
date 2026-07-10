import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MAP_BOUNDS } from '../graph/mapData.js'
import { TrafficSystem } from '../sim/traffic.js'
import { AGENT_STATE } from '../sim/agents.js'
import { SIM_CONFIG } from '../sim/config.js'
import { INCIDENT_TYPES, createIncidentMarker } from '../sim/incidents.js'
import { ANALYTICS_CONFIG } from '../analytics/config.js'
import { buildRoads, buildStreetLabels, buildOriginDestMarkers, buildRoute } from './worldBuilders.js'
import { SnapshotInterpolator } from '../net/interpolation.js'

// ════════════════════════════════════════════════════════════════
//  MUNDO ONLINE (M2/M3) — render compartido por adminView y userView.
//  El cliente NO simula: dibuja el world_snapshot del servidor.
//  M3: los avatares se colorean por DUEÑO (usuario 1/2/3), la flota
//  propia se resalta (highlightOwner), los incidentes llegan en el
//  snapshot y se dibujan con el mismo marcador del modo offline, y
//  cada flota configurada pinta su ruta óptima en su color.
// ════════════════════════════════════════════════════════════════
const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
const MAP_CX = (xMin + xMax) / 2
const MAP_CZ = (zMin + zMax) / 2
const MAP_W = xMax - xMin
const MAP_D = zMax - zMin

// Colores por dueño (slot 1..3) — distintos entre sí y de los 4 colores de incidente
export const OWNER_COLORS = { 1: '#3b82f6', 2: '#84cc16', 3: '#f472b6' }
const OWNER_THREE = Object.fromEntries(Object.entries(OWNER_COLORS).map(([k, v]) => [k, new THREE.Color(v)]))
const FALLBACK_COLOR = new THREE.Color('#94a3b8')   // owner desconocido (p.ej. flota demo)
const WHITE = new THREE.Color('#ffffff')
// owner ≥ 100 = VEHÍCULO PERSONAL del slot (owner − 100): más grande y más claro
export const PERSONAL_OFFSET = 100

export function createOnlineWorld(canvas, { initialMode = '2d', onHud = null, highlightOwner = null } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1520)
  scene.fog = new THREE.Fog(0x0d1520, 300, 750)
  scene.add(new THREE.AmbientLight(0xffffff, 0.85))
  const sun = new THREE.DirectionalLight(0xffffff, 0.9)
  sun.position.set(120, 220, 80)
  scene.add(sun)

  // ── Cámaras: ortográfica cenital (2D) y perspectiva navegable (3D) ──
  const perspCam = new THREE.PerspectiveCamera(55, 1, 0.1, 1400)
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1400)
  orthoCam.position.set(MAP_CX, 400, MAP_CZ)
  orthoCam.lookAt(MAP_CX, 0, MAP_CZ)
  orthoCam.up.set(0, 0, -1)
  perspCam.position.set(MAP_CX - 160, 200, MAP_CZ + 260)
  const controls = new OrbitControls(perspCam, canvas)
  controls.target.set(MAP_CX, 0, MAP_CZ)
  controls.maxPolarAngle = Math.PI / 2 - 0.02
  controls.enableDamping = true
  controls.update()

  let mode = initialMode
  controls.enabled = mode === '3d'

  // ── Mundo estático: vías + rótulos + los 15 puntos con su color de categoría ──
  buildRoads(scene)
  const labelMeshes = buildStreetLabels(scene)
  buildOriginDestMarkers(scene, null, null)   // sin origen/destino únicos: cada flota tiene el suyo
  const traffic = new TrafficSystem(scene)    // la fase la dicta el servidor (setPhaseIndex)
  let runGroup = new THREE.Group()            // rutas óptimas por flota (se rehace con cada sim_info)
  scene.add(runGroup)

  // ── Avatares remotos: InstancedMesh alimentado por el interpolador ──
  const agentMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.3, 1.1, SIM_CONFIG.CAR_LENGTH),
    new THREE.MeshBasicMaterial(),
    SIM_CONFIG.MAX_AGENTS
  )
  agentMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  agentMesh.frustumCulled = false
  scene.add(agentMesh)
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler()
  const _pos = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _zero = new THREE.Vector3(0, 0, 0)
  const _big = new THREE.Vector3(1.35, 1.35, 1.35)     // la flota propia se dibuja más grande
  const _pers = new THREE.Vector3(1.9, 1.9, 1.9)       // el vehículo personal, aún más
  const _color = new THREE.Color()
  // todas ocultas hasta el primer snapshot
  _m4.compose(_pos.set(0, 0, 0), _q.identity(), _zero)
  for (let i = 0; i < SIM_CONFIG.MAX_AGENTS; i++) agentMesh.setMatrixAt(i, _m4)
  agentMesh.instanceMatrix.needsUpdate = true

  // ── Overlay de zonas rojas (M5): un plano por celda, visibles según snapshot.rz ──
  // Grilla anclada a mitad de manzana (ver analytics/config.js); las celdas del
  // borde se recortan a MAP_BOUNDS para no flotar fuera de las avenidas límite.
  const CFG = ANALYTICS_CONFIG
  const zonePlanes = []
  {
    for (let zz = 0; zz < CFG.GRID_ROWS; zz++) {
      for (let zx = 0; zx < CFG.GRID_COLS; zx++) {
        const x0 = Math.max(CFG.ZONE_ORIGIN_X + zx * CFG.ZONE_CELL, xMin)
        const x1 = Math.min(CFG.ZONE_ORIGIN_X + (zx + 1) * CFG.ZONE_CELL, xMax)
        const z0 = Math.max(CFG.ZONE_ORIGIN_Z + zz * CFG.ZONE_CELL, zMin)
        const z1 = Math.min(CFG.ZONE_ORIGIN_Z + (zz + 1) * CFG.ZONE_CELL, zMax)
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry((x1 - x0) * 0.94, (z1 - z0) * 0.94),
          // Opacity 0.35: at 0.22 the plane barely read against the dark ground,
          // and users missed active red zones entirely in the 2D view.
          new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.35, depthWrite: false })
        )
        mesh.rotation.x = -Math.PI / 2
        mesh.position.set((x0 + x1) / 2, 0.5, (z0 + z1) / 2)
        mesh.visible = false
        scene.add(mesh)
        zonePlanes.push(mesh)
      }
    }
  }
  function syncRedZones(rz) {
    const red = new Set(rz)
    for (let i = 0; i < zonePlanes.length; i++) zonePlanes[i].visible = red.has(i)
  }

  // ── Marcadores de incidentes: sincronizados con la lista del snapshot ──
  const incidentMeshes = new Map()   // id → mesh
  function syncIncidents(flat) {     // flat: [id, typeIndex, x, z] × incidente
    const alive = new Set()
    for (let k = 0; k < flat.length; k += 4) {
      const id = flat[k]
      alive.add(id)
      if (!incidentMeshes.has(id)) {
        const mesh = createIncidentMarker(INCIDENT_TYPES[flat[k + 1]] ?? INCIDENT_TYPES[0])
        mesh.position.set(flat[k + 2], 0.6, flat[k + 3])
        scene.add(mesh)
        incidentMeshes.set(id, mesh)
      }
    }
    for (const [id, mesh] of incidentMeshes) {
      if (alive.has(id)) continue
      scene.remove(mesh)
      mesh.geometry.dispose(); mesh.material.dispose()
      incidentMeshes.delete(id)
    }
  }

  const interp = new SnapshotInterpolator(120)
  let lastSnap = null
  let snapCount = 0

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight
    renderer.setSize(w, h, false)
    perspCam.aspect = w / h
    perspCam.updateProjectionMatrix()
    const aspect = w / h
    const halfH = Math.max(MAP_D, MAP_W / aspect) / 2 + 45
    orthoCam.left = -halfH * aspect; orthoCam.right = halfH * aspect
    orthoCam.top = halfH; orthoCam.bottom = -halfH
    orthoCam.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()

  let rafId = null, hudTimer = 0, lastT = performance.now()
  function animate() {
    rafId = requestAnimationFrame(animate)
    const now = performance.now()
    const dt = (now - lastT) / 1000
    lastT = now

    const agents = interp.sample()
    if (agents) {
      let n = 0
      for (const ag of agents) {
        const isPersonal = ag.o >= PERSONAL_OFFSET
        const slot = isPersonal ? ag.o - PERSONAL_OFFSET : ag.o
        const own = highlightOwner != null && slot === highlightOwner
        _e.set(0, ag.h, 0); _q.setFromEuler(_e)
        _m4.compose(_pos.set(ag.x, 0.55, ag.z), _q, isPersonal ? _pers : own ? _big : _one)
        agentMesh.setMatrixAt(n, _m4)
        // color por dueño; el personal PARPADEA hacia blanco (~0.8s) para no
        // camuflarse con la flota de su mismo color; llegados se apagan;
        // lo ajeno se atenúa cuando hay resaltado (vista de usuario)
        _color.copy(OWNER_THREE[slot] ?? FALLBACK_COLOR)
        if (isPersonal) _color.lerp(WHITE, 0.55 + 0.45 * Math.sin(now * 0.008))
        if (ag.s === AGENT_STATE.ARRIVED) _color.multiplyScalar(0.45)
        if (highlightOwner != null && !own) _color.multiplyScalar(0.4)
        agentMesh.setColorAt(n, _color)
        n++
      }
      for (let i = n; i < SIM_CONFIG.MAX_AGENTS; i++) {   // ocultar sobrantes
        _m4.compose(_pos.set(0, 0, 0), _q.identity(), _zero)
        agentMesh.setMatrixAt(i, _m4)
      }
      agentMesh.instanceMatrix.needsUpdate = true
      if (agentMesh.instanceColor) agentMesh.instanceColor.needsUpdate = true
    }

    hudTimer += dt
    if (hudTimer >= 0.5 && onHud) {
      onHud({
        tick: lastSnap?.tick ?? null,
        spawned: lastSnap?.spawned ?? 0,
        arrived: lastSnap?.arrived ?? 0,
        running: lastSnap?.running ?? true,
        rate: snapCount / hudTimer,
      })
      snapCount = 0; hudTimer = 0
    }

    if (mode === '3d') controls.update()
    renderer.render(scene, mode === '2d' ? orthoCam : perspCam)
  }
  animate()

  return {
    get mode() { return mode },
    setMode(m) { mode = m; controls.enabled = m === '3d' },

    // sim_info (M3): una ruta óptima por flota configurada, en el color de su dueño
    applySimInfo(msg) {
      runGroup.removeFromParent()
      runGroup.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose() })
      runGroup = new THREE.Group()
      for (const f of msg.fleets ?? []) {
        if (!f.origin || !f.dest) continue
        buildRoute(runGroup, f.origin, f.dest, new THREE.Color(OWNER_COLORS[f.slot] ?? '#94a3b8'))
      }
      scene.add(runGroup)
    },

    // world_snapshot del servidor: buffer + semáforos + incidentes
    pushSnapshot(msg) {
      interp.push(msg)
      lastSnap = msg
      snapCount++
      traffic.setPhaseIndex(msg.phase)
      syncIncidents(msg.inc ?? [])
      syncRedZones(msg.rz ?? [])
    },

    dispose() {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      controls.dispose()
      traffic.dispose()
      syncIncidents([])   // limpia todos los marcadores de incidente
      zonePlanes.forEach(p => { p.geometry.dispose(); p.material.dispose(); p.removeFromParent() })
      agentMesh.geometry.dispose(); agentMesh.material.dispose(); agentMesh.removeFromParent()
      labelMeshes.forEach(m => { m.material.map?.dispose(); m.material.dispose(); m.geometry.dispose() })
      renderer.dispose()
    },
  }
}

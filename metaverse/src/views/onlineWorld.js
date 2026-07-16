import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MAP_BOUNDS } from '../graph/mapData.js'
import { TrafficSystem } from '../sim/traffic.js'
import { AGENT_STATE } from '../sim/agents.js'
import { SIM_CONFIG } from '../sim/config.js'
import { INCIDENT_TYPES, createIncidentMarker } from '../sim/incidents.js'
import { ANALYTICS_CONFIG } from '../analytics/config.js'
import { buildRoads, buildStreetLabels, buildOriginDestMarkers, buildRoute, buildDashedRoute } from './worldBuilders.js'
import { createChatBubbles } from './chatBubbles.js'
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

// ── Cámara conductor ('chase'): va detrás del vehículo personal ──
// El ángulo es el compromiso del modo: bajarla da sensación de manejar, pero las
// zonas rojas son planos a y=0.5 y desde el ras del piso se ven de canto. Con
// estos valores la cámara mira ~21° hacia abajo (atan(8/21)), suficiente para
// leer una celda de 30 unidades sin perder la vista de conductor. Quien quiera
// verlas de verdad tiene el botón 2D — ver camControls.js.
const CHASE_BACK = 15        // unidades detrás del auto
const CHASE_HEIGHT = 9       // altura de la cámara sobre el piso
const CHASE_AHEAD = 6        // el punto que mira, adelante del auto
const CHASE_EYE = 1          // altura de ese punto (el techo del auto es 1.1)
const CHASE_DAMP = 6         // suavizado exponencial (1/s); ver updateChase

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

  // Blanco suavizado de la cámara conductor. Arranca en el centro del mapa para
  // que un '3d' anterior a cualquier chase orbite donde siempre orbitó.
  const _chaseTarget = new THREE.Vector3(MAP_CX, 0, MAP_CZ)
  const _chaseWant = new THREE.Vector3(), _chaseLook = new THREE.Vector3()
  let chaseSnap = true   // true = el próximo frame se planta sin barrer el mapa

  // ── Mundo estático: vías + rótulos + los 15 puntos con su color de categoría ──
  buildRoads(scene)
  const labelMeshes = buildStreetLabels(scene)
  buildOriginDestMarkers(scene, null, null)   // sin origen/destino únicos: cada flota tiene el suyo
  const traffic = new TrafficSystem(scene)    // la fase la dicta el servidor (setPhaseIndex)
  let runGroup = new THREE.Group()            // rutas óptimas por flota (se rehace con cada sim_info)
  scene.add(runGroup)
  // Ruta VIVA del vehículo personal (punteada, cian): la manda el servidor en cada
  // drive_state, ya resuelta sobre el grafo con las zonas rojas penalizadas.
  let suggestMesh = null

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

  // ── Burbujas de chat: una por slot, ancladas al avatar que lo representa ──
  const bubbles = createChatBubbles(scene)
  const chatAnchors = new Map()   // slot → avatar interpolado (se rehace cada frame)

  const interp = new SnapshotInterpolator(120)
  let lastSnap = null
  let snapCount = 0

  // Cámara conductor: se planta detrás del vehículo personal y mira adelante.
  // El blanco sale de chatAnchors, que el bucle rehace cada frame con la posición
  // YA interpolada — la misma que se dibuja. Seguir el snapshot crudo daría una
  // cámara a tirones a 10 Hz sobre un auto que se mueve suave.
  //
  // Suavizado exponencial (1 − e^(−k·dt)) y no un lerp de factor fijo: el factor
  // fijo ata la cámara al framerate, y este mundo corre a 60 Hz en una máquina y
  // a 144 en otra. Sin él, cada giro del volante da un latigazo.
  //
  // Sin vehículo (no invocado, o ya llegado) devuelve false y NO toca la cámara:
  // congelar es lo correcto por un frame suelto entre snapshots. Salir de chase
  // cuando el vehículo deja la vía es decisión de la vista, no de acá (camControls).
  function updateChase(dt) {
    const ag = highlightOwner != null ? chatAnchors.get(highlightOwner) : null
    if (!ag) return false
    // heading = atan2(dx, dz) (agents.js) ⇒ el frente del auto es (sin h, cos h)
    const fx = Math.sin(ag.h), fz = Math.cos(ag.h)
    _chaseWant.set(ag.x - fx * CHASE_BACK, CHASE_HEIGHT, ag.z - fz * CHASE_BACK)
    _chaseLook.set(ag.x + fx * CHASE_AHEAD, CHASE_EYE, ag.z + fz * CHASE_AHEAD)
    const k = chaseSnap ? 1 : 1 - Math.exp(-CHASE_DAMP * dt)
    perspCam.position.lerp(_chaseWant, k)
    _chaseTarget.lerp(_chaseLook, k)
    perspCam.lookAt(_chaseTarget)
    chaseSnap = false
    return true
  }

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
      chatAnchors.clear()
      let n = 0
      for (const ag of agents) {
        const isPersonal = ag.o >= PERSONAL_OFFSET
        const slot = isPersonal ? ag.o - PERSONAL_OFFSET : ag.o
        // Ancla de la burbuja: SOLO el vehículo personal. La flota son vehículos
        // simulados, no el avatar de nadie: si hablaran ellos, el mensaje saldría
        // de un carro cualquiera de la oleada. Sin vehículo personal invocado el
        // mensaje vive únicamente en el panel de chat.
        if (isPersonal) chatAnchors.set(slot, ag)
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
    bubbles.update(now, chatAnchors, mode === '2d')

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

    // OrbitControls y la cámara conductor se pelean por perspCam.position: solo
    // uno de los dos puede correr por frame, y por eso chase apaga los controls.
    if (mode === '3d') controls.update()
    else if (mode === 'chase') updateChase(dt)
    renderer.render(scene, mode === '2d' ? orthoCam : perspCam)
  }
  animate()

  return {
    get mode() { return mode },
    setMode(m) {
      if (m === mode) return
      // Al SALIR de conductor, la órbita hereda el punto que la cámara venía
      // mirando. OrbitControls recompone perspCam alrededor de SU target: si
      // quedara en el centro del mapa, el primer update() daría un latigazo
      // desde el auto hasta allá. Se copia al salir hacia cualquier modo, no
      // solo hacia '3d', porque la cámara se queda donde la dejó el conductor
      // y un '2d' de por medio no la mueve.
      if (mode === 'chase') controls.target.copy(_chaseTarget)
      // Al ENTRAR, plantarse detrás del auto en el primer frame en vez de barrer
      // el mapa entero hasta él.
      if (m === 'chase') chaseSnap = true
      mode = m
      controls.enabled = m === '3d'
    },

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

    // drive_state → la ruta VIVA del vehículo personal, punteada. Llega ya resuelta
    // desde el servidor (el único con el grafo penalizado por las zonas rojas), y
    // cambia sola cuando Spark pinta una zona: ahí se separa de la sólida, que es la
    // ruta ideal sin eventos. `null` la borra (el vehículo dejó la vía).
    showSuggestedRoute(nodes) {
      if (suggestMesh) {
        suggestMesh.geometry.dispose(); suggestMesh.material.dispose(); suggestMesh.removeFromParent()
        suggestMesh = null
      }
      suggestMesh = buildDashedRoute(nodes)
      if (suggestMesh) scene.add(suggestMesh)
    },

    // chat_message → burbuja sobre el avatar del emisor. Solo los usuarios
    // (slot 1..3) tienen avatar; el admin no habla por aquí, su mensaje lo
    // anuncia el borde de la ventana (chatBanner.js).
    sayChat(slot, text) {
      const color = OWNER_COLORS[slot]
      if (!color) return
      bubbles.say(slot, text, color)
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
      bubbles.dispose()
      if (suggestMesh) { suggestMesh.geometry.dispose(); suggestMesh.material.dispose(); suggestMesh.removeFromParent() }
      syncIncidents([])   // limpia todos los marcadores de incidente
      zonePlanes.forEach(p => { p.geometry.dispose(); p.material.dispose(); p.removeFromParent() })
      agentMesh.geometry.dispose(); agentMesh.material.dispose(); agentMesh.removeFromParent()
      labelMeshes.forEach(m => { m.material.map?.dispose(); m.material.dispose(); m.geometry.dispose() })
      renderer.dispose()
    },
  }
}

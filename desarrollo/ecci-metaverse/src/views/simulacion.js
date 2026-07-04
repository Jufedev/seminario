import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { navigate } from '../router.js'
import { store } from '../state/store.js'
import { kafka } from '../kafka/producer.js'
import {
  CALLES, CARRERAS, GRAPH, NODES, POINTS, MAP_BOUNDS,
  dijkstra, pointNode, pathLengthUnits, UNIT_TO_METERS, allEdges, resetGraph,
} from '../graph/mapData.js'
import { AgentSystem } from '../sim/agents.js'
import { TrafficSystem } from '../sim/traffic.js'
import { IncidentManager } from '../sim/incidents.js'
import { SIM_CONFIG } from '../sim/config.js'
import { ZoneSystem } from '../analytics/zones.js'
import { attachPipeline } from '../analytics/pipeline.js'
import { Dashboard } from '../analytics/dashboard.js'

// ════════════════════════════════════════════════════════════════
//  VISTA 3 — SIMULACIÓN: mapa + ruta + cámara 2D/3D (fase 1), hasta
//  500 avatares con semáforos sincronizados (fase 2), e incidentes +
//  analítica de zonas 6×6 + dashboard en vivo (fase 3).
// ════════════════════════════════════════════════════════════════
const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
const MAP_CX = (xMin + xMax) / 2
const MAP_CZ = (zMin + zMax) / 2
const MAP_W = xMax - xMin
const MAP_D = zMax - zMin

export function renderSimulacion(app) {
  // Sin origen/destino elegidos no hay nada que simular → volver a configurar
  if (!store.originId || !store.destId) { navigate('#/config'); return }

  // Red de seguridad: si una simulación anterior dejó bloqueos/penalizaciones sin
  // limpiar (aunque dispose() ya debería haberlo hecho), esto garantiza un grafo limpio.
  resetGraph()

  // Live mode: connect to the bridge backend if VITE_BRIDGE_WS_URL is set
  // (no-op otherwise; the producer stays in simulated mode).
  kafka.connect()

  const view = document.createElement('div')
  view.className = 'view-sim'
  view.innerHTML = `
    <canvas id="sim-canvas"></canvas>
    <div class="sim-topbar">
      <div class="panel sim-metrics" id="sim-metrics">
        <h3>Métricas en vivo</h3>
        <div class="row"><span class="k">Origen</span><span class="v" id="m-origin">—</span></div>
        <div class="row"><span class="k">Destino</span><span class="v" id="m-dest">—</span></div>
        <div class="row"><span class="k">Distancia ruta óptima</span><span class="v" id="m-dist">—</span></div>
        <div class="row"><span class="k">Tiempo transcurrido</span><span class="v" id="m-time">00:00</span></div>
        <div class="row"><span class="k">Avatares activos</span><span class="v" id="m-active">0</span></div>
        <div class="row"><span class="k">· esperando semáforo</span><span class="v" id="m-waiting">0</span></div>
        <div class="row"><span class="k">· atascados</span><span class="v" id="m-stuck">0</span></div>
        <div class="row"><span class="k">Llegaron</span><span class="v" id="m-arrived">0 / 0</span></div>
        <div class="row"><span class="k">Velocidad promedio</span><span class="v" id="m-speed">0 m/s</span></div>
        <div class="row"><span class="k">Recálculos de ruta</span><span class="v" id="m-recalc">0</span></div>
        <div class="row"><span class="k">Zonas rojas activas</span><span class="v" id="m-zonas">— (fase 3)</span></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
        <button class="btn secondary" id="btn-back">← Configuración</button>
        <div class="cam-toggle panel" style="padding:6px">
          <button id="btn-cam-2d" class="active">🗺️ 2D</button>
          <button id="btn-cam-3d">🧭 3D</button>
        </div>
      </div>
    </div>
  `
  // Pipeline mode with no bridge configured would silently disable ALL
  // detection (local flagging off, nothing arriving from Spark): make it loud.
  if (store.detectionMode === 'pipeline' && !kafka.isLive()) {
    console.warn('[sim] Detection mode "pipeline" but no bridge configured (VITE_BRIDGE_WS_URL); no red zones will be detected')
    const warn = document.createElement('div')
    warn.className = 'panel'
    warn.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:10;border:1px solid #c0392b;color:#c0392b;padding:8px 12px'
    warn.textContent = 'Modo pipeline sin puente configurado (VITE_BRIDGE_WS_URL): no se detectarán zonas rojas'
    view.appendChild(warn)
  }
  app.appendChild(view)
  view.querySelector('#btn-back').addEventListener('click', () => navigate('#/config'))

  const canvas = view.querySelector('#sim-canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1520)
  scene.fog = new THREE.Fog(0x0d1520, 260, 620)

  scene.add(new THREE.AmbientLight(0xffffff, 0.85))
  const sun = new THREE.DirectionalLight(0xffffff, 0.9)
  sun.position.set(120, 220, 80)
  scene.add(sun)

  // ── Dos cámaras: perspectiva (3D navegable) y ortográfica (2D cenital) ──
  const perspCam = new THREE.PerspectiveCamera(55, 1, 0.1, 1200)
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1200)
  orthoCam.position.set(MAP_CX, 400, MAP_CZ)
  orthoCam.lookAt(MAP_CX, 0, MAP_CZ)
  orthoCam.up.set(0, 0, -1)   // norte (z bajo) arriba en pantalla

  perspCam.position.set(MAP_CX - 140, 180, MAP_CZ + 220)

  const controls = new OrbitControls(perspCam, canvas)
  controls.target.set(MAP_CX, 0, MAP_CZ)
  controls.maxPolarAngle = Math.PI / 2 - 0.02
  controls.enableDamping = true
  controls.update()

  let mode = '2d'   // '2d' | '3d'
  const btn2d = view.querySelector('#btn-cam-2d')
  const btn3d = view.querySelector('#btn-cam-3d')
  function setMode(m) {
    mode = m
    btn2d.classList.toggle('active', m === '2d')
    btn3d.classList.toggle('active', m === '3d')
    controls.enabled = m === '3d'
  }
  btn2d.addEventListener('click', () => setMode('2d'))
  btn3d.addEventListener('click', () => setMode('3d'))

  // ── Construcción de las vías a partir del grafo (una malla por categoría → pocos draw calls) ──
  buildRoads(scene)
  buildOriginDestMarkers(scene)
  const routeInfo = buildRoute(scene)

  // ── Métricas estáticas de esta fase ──
  const oP = POINTS.find(p => p.id === store.originId)
  const dP = POINTS.find(p => p.id === store.destId)
  view.querySelector('#m-origin').textContent = `${oP.id} · ${oP.name}`
  view.querySelector('#m-dest').textContent = `${dP.id} · ${dP.name}`
  view.querySelector('#m-dist').textContent = routeInfo ? `${Math.round(routeInfo.meters)} m` : 'sin ruta'

  kafka.send('route.computed', {
    origin: store.originId, dest: store.destId,
    distance_m: routeInfo ? Math.round(routeInfo.meters) : null,
  })

  // ── Motor de simulación masiva: semáforos + hasta 500 avatares en un InstancedMesh ──
  const trafficSystem = new TrafficSystem(scene)
  const agentSystem = new AgentSystem(scene, {
    total: Math.max(1, Math.min(SIM_CONFIG.MAX_AGENTS, store.numAvatars)),
    originId: pointNode(store.originId),
    destId: pointNode(store.destId),
    traffic: trafficSystem,
  })

  // ── Fase 3: incidentes que bloquean tramos + analítica de zonas + dashboard ──
  const incidentManager = new IncidentManager(scene, {
    agentSystem, graphEdges: allEdges(), frequencySec: store.incidentFreq,
  })
  const zoneSystem = new ZoneSystem(scene, { agentSystem, incidentManager, detectionMode: store.detectionMode })
  // Pipeline red points arriving through the bridge feed the zone system
  // (only applied when detectionMode is 'pipeline').
  const detachPipeline = attachPipeline(zoneSystem)
  const dashboard = new Dashboard(view, {
    agentSystem, zoneSystem, incidentManager,
    optimalDistanceMeters: routeInfo ? routeInfo.meters : 0,
  })

  // Gancho de depuración en consola (window.__DEBUG_SIM.agentSystem.getStats(), etc.).
  // Se limpia en el teardown para no retener en memoria una simulación ya descartada.
  window.__DEBUG_SIM = { scene, agentSystem, trafficSystem, incidentManager, zoneSystem, dashboard, camera: perspCam, renderer, orthoCam, GRAPH }

  const mArrived = view.querySelector('#m-arrived')
  const mActive = view.querySelector('#m-active')
  const mWaiting = view.querySelector('#m-waiting')
  const mStuck = view.querySelector('#m-stuck')
  const mSpeed = view.querySelector('#m-speed')
  const mRecalc = view.querySelector('#m-recalc')
  const mTime = view.querySelector('#m-time')
  mArrived.textContent = `0 / ${agentSystem.total}`

  const mZonas = view.querySelector('#m-zonas')
  let simTime = 0
  let hudTimer = 0
  function refreshHud() {
    const s = agentSystem.getStats()
    mActive.textContent = s.active
    mWaiting.textContent = s.waiting
    mStuck.textContent = s.stuck
    mArrived.textContent = `${s.arrived} / ${s.total}`
    mSpeed.textContent = `${s.avgSpeedMps.toFixed(1)} m/s`
    mRecalc.textContent = s.rerouteCount
    mZonas.textContent = `${zoneSystem.getRedCount()} / ${zoneSystem.n} · incidentes: ${incidentManager.getActiveCount()}`
    const mm = Math.floor(simTime / 60), ss = Math.floor(simTime % 60)
    mTime.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }

  // ── Resize: ajusta ambas cámaras y el tamaño del canvas ──
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight
    renderer.setSize(w, h, false)
    perspCam.aspect = w / h
    perspCam.updateProjectionMatrix()
    const aspect = w / h
    const halfH = Math.max(MAP_D, MAP_W / aspect) / 2 + 20
    const halfW = halfH * aspect
    orthoCam.left = -halfW; orthoCam.right = halfW
    orthoCam.top = halfH; orthoCam.bottom = -halfH
    orthoCam.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()

  // ── Loop de render ──
  let rafId, lastT = performance.now(), everyoneArrived = false
  function animate() {
    rafId = requestAnimationFrame(animate)
    const now = performance.now()
    const dt = Math.min((now - lastT) / 1000, 0.05)   // clamp: evita saltos si la pestaña pierde foco
    lastT = now
    simTime += dt

    trafficSystem.update(dt)
    agentSystem.update(dt, simTime)
    incidentManager.update(dt, simTime)
    zoneSystem.update(dt, simTime)
    dashboard.update(dt, simTime)

    // Fin automático: todos los avatares configurados ya salieron y llegaron
    if (!everyoneArrived && agentSystem.spawned >= agentSystem.total && agentSystem.arrivedCount >= agentSystem.total) {
      everyoneArrived = true
      dashboard.finalize()
    }

    hudTimer += dt
    if (hudTimer >= 0.3) { hudTimer = 0; refreshHud() }

    if (mode === '3d') controls.update()
    renderer.render(scene, mode === '2d' ? orthoCam : perspCam)
  }
  animate()

  window.__teardownView = () => {
    cancelAnimationFrame(rafId)
    window.removeEventListener('resize', resize)
    detachPipeline()
    kafka.disconnect()
    controls.dispose()
    dashboard.dispose()
    zoneSystem.dispose()
    incidentManager.dispose()
    agentSystem.dispose()
    trafficSystem.dispose()
    renderer.dispose()
    window.__DEBUG_SIM = null
  }
}

// ── Construye la malla de calles/carreras/diagonales agrupada por categoría ──
function buildRoads(scene) {
  const normalGeoms = [], avenidaGeoms = [], diagonalGeoms = []
  const seen = new Set()

  for (const aId in GRAPH) {
    for (const edge of GRAPH[aId]) {
      const key = [aId, edge.to].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)

      const na = NODES[aId], nb = NODES[edge.to]
      const dx = nb.x - na.x, dz = nb.z - na.z
      const len = Math.hypot(dx, dz)
      const midX = (na.x + nb.x) / 2, midZ = (na.z + nb.z) / 2
      const angle = -Math.atan2(dx, dz)

      let width = 6, bucket = normalGeoms
      if (edge.kind === 'diagonal') { width = 5; bucket = diagonalGeoms }
      else {
        const isAvenida = edge.kind === 'calle' ? CALLES[na.ri].avenida : CARRERAS[na.ci].avenida
        if (isAvenida) { width = 11; bucket = avenidaGeoms } else { width = 8; bucket = normalGeoms }
      }

      const geo = new THREE.PlaneGeometry(width, len)
      geo.rotateX(-Math.PI / 2)
      geo.rotateY(angle)
      geo.translate(midX, 0.02, midZ)
      bucket.push(geo)
    }
  }

  const mats = {
    normal: new THREE.MeshLambertMaterial({ color: 0x33424f }),
    avenida: new THREE.MeshLambertMaterial({ color: 0x3d5568 }),
    diagonal: new THREE.MeshLambertMaterial({ color: 0x4a4530 }),
  }
  ;[[normalGeoms, mats.normal], [avenidaGeoms, mats.avenida], [diagonalGeoms, mats.diagonal]].forEach(([geoms, mat]) => {
    if (!geoms.length) return
    const merged = mergeGeometries(geoms, false)
    scene.add(new THREE.Mesh(merged, mat))
  })

  // Plano de fondo (manzanas / "tierra"), ligeramente por debajo de las vías
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_W + 80, MAP_D + 80),
    new THREE.MeshLambertMaterial({ color: 0x161d28 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.set(MAP_CX, -0.02, MAP_CZ)
  scene.add(ground)

  // Nodos de intersección (parche pequeño para tapar uniones de las tiras de vía)
  const nodeGeoms = []
  for (const id in NODES) {
    const n = NODES[id]
    const g = new THREE.CircleGeometry(4.2, 10)
    g.rotateX(-Math.PI / 2)
    g.translate(n.x, 0.03, n.z)
    nodeGeoms.push(g)
  }
  scene.add(new THREE.Mesh(mergeGeometries(nodeGeoms, false), mats.normal))
}

// ── Marcadores de los 15 puntos fijos, resaltando el origen/destino elegidos ──
function buildOriginDestMarkers(scene) {
  POINTS.forEach(p => {
    const n = NODES[p.node]
    const isOrigin = p.id === store.originId
    const isDest = p.id === store.destId
    const color = isOrigin ? 0x34d399 : isDest ? 0xf87171 : 0x2a3546
    const h = isOrigin || isDest ? 6 : 2.4
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(isOrigin || isDest ? 2.2 : 1.1, isOrigin || isDest ? 2.2 : 1.1, h, 14),
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: isOrigin || isDest ? 0.5 : 0.15 })
    )
    mesh.position.set(n.x, h / 2, n.z)
    scene.add(mesh)
  })
}

// ── Calcula y dibuja la ruta Dijkstra entre el origen y el destino elegidos ──
function buildRoute(scene) {
  const startId = pointNode(store.originId)
  const goalId = pointNode(store.destId)
  const path = dijkstra(startId, goalId)
  if (!path) return null

  const mat = new THREE.MeshBasicMaterial({ color: 0x60a5fa })
  const geoms = []
  for (let i = 0; i < path.length - 1; i++) {
    const a = NODES[path[i]], b = NODES[path[i + 1]]
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz)
    const angle = -Math.atan2(dx, dz)
    const geo = new THREE.PlaneGeometry(1.6, len)
    geo.rotateX(-Math.PI / 2)
    geo.rotateY(angle)
    geo.translate((a.x + b.x) / 2, 0.15, (a.z + b.z) / 2)
    geoms.push(geo)
  }
  scene.add(new THREE.Mesh(mergeGeometries(geoms, false), mat))

  const meters = pathLengthUnits(path) * UNIT_TO_METERS
  return { path, meters }
}

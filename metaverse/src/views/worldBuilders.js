import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  CALLES, CARRERAS, GRAPH, NODES, POINTS, CATEGORIES, MAP_BOUNDS,
  dijkstra, pointNode, pathLengthUnits, UNIT_TO_METERS,
} from '../graph/mapData.js'

// ════════════════════════════════════════════════════════════════
//  MUNDO ESTÁTICO — constructores compartidos del trazado 3D:
//  vías + rótulos de calles + marcadores de puntos + ruta Dijkstra.
//  Los reutiliza la vista online (onlineWorld.js) para dibujar el
//  world_snapshot del servidor. El cliente NO simula: solo renderiza.
// ════════════════════════════════════════════════════════════════
const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
const MAP_CX = (xMin + xMax) / 2
const MAP_CZ = (zMin + zMax) / 2
const MAP_W = xMax - xMin
const MAP_D = zMax - zMin

// ── Construye la malla de calles/carreras agrupada por categoría (pocos draw calls) ──
export function buildRoads(scene) {
  const normalGeoms = [], avenidaGeoms = []
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

      const isAvenida = edge.kind === 'calle' ? CALLES[na.ri].avenida : CARRERAS[na.ci].avenida
      const width = isAvenida ? 11 : 8
      const bucket = isAvenida ? avenidaGeoms : normalGeoms

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
  }
  ;[[normalGeoms, mats.normal], [avenidaGeoms, mats.avenida]].forEach(([geoms, mat]) => {
    if (!geoms.length) return
    const merged = mergeGeometries(geoms, false)
    scene.add(new THREE.Mesh(merged, mat))
  })

  // Plano de fondo (manzanas / "tierra"), ligeramente por debajo de las vías
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_W + 110, MAP_D + 110),
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

// ── Rótulo plano sobre el suelo: texto con halo en un canvas → textura → plano ──
// vertical=true lo gira 90° para que corra a lo largo de una carrera (se lee hacia el norte).
function makeLabel(text, { size = 5, color = '#c9d4e3', opacity = 0.85, bold = false, vertical = false }) {
  const fontPx = 48
  const font = `${bold ? 'bold ' : ''}${fontPx}px 'Segoe UI', sans-serif`
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = font
  const cnv = document.createElement('canvas')
  cnv.width = Math.ceil(probe.measureText(text).width) + 24
  cnv.height = fontPx + 20
  const c2 = cnv.getContext('2d')
  c2.font = font; c2.textAlign = 'center'; c2.textBaseline = 'middle'
  c2.lineWidth = 8; c2.strokeStyle = 'rgba(7,12,20,0.9)'
  c2.strokeText(text, cnv.width / 2, cnv.height / 2)
  c2.fillStyle = color
  c2.fillText(text, cnv.width / 2, cnv.height / 2)

  const tex = new THREE.CanvasTexture(cnv)
  tex.anisotropy = 4
  const geo = new THREE.PlaneGeometry(size * cnv.width / cnv.height, size)
  geo.rotateX(-Math.PI / 2)                      // acostado sobre el suelo, legible desde arriba
  if (vertical) geo.rotateY(Math.PI / 2)         // a lo largo de la carrera (lee de sur a norte)
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false })
  return new THREE.Mesh(geo, mat)
}

// ── Rótulos de TODAS las vías (estilo Google Maps) + 4 rótulos grandes de borde ──
export function buildStreetLabels(scene) {
  const meshes = []
  const add = (mesh, x, z) => { mesh.position.set(x, 0.08, z); scene.add(mesh); meshes.push(mesh) }

  // Cada carrera: 2 rótulos a media manzana (z=±75 no coincide con ninguna calle)
  CARRERAS.forEach(cr => {
    add(makeLabel(cr.name, { vertical: true }), cr.x, 75)
    add(makeLabel(cr.name, { vertical: true }), cr.x, -75)
  })
  // Cada calle: 2 rótulos a media manzana (x=±90 queda entre carreras)
  CALLES.forEach(cl => {
    add(makeLabel(cl.name, {}), -90, cl.z)
    add(makeLabel(cl.name, {}), 90, cl.z)
  })
  // Bordes: texto grande fuera del trazado
  const big = { size: 13, bold: true, color: '#e2eaf5', opacity: 0.95 }
  add(makeLabel('AVENIDA 30', { ...big, vertical: true }), xMin - 22, 0)
  add(makeLabel('CARACAS', { ...big, vertical: true }), xMax + 22, 0)
  add(makeLabel('CALLE 45', big), 0, zMax + 22)   // sur (abajo en pantalla)
  add(makeLabel('CALLE 57', big), 0, zMin - 22)   // norte (arriba)
  return meshes
}

// ── Marcadores de los 15 puntos, con el color de su categoría; origen/destino resaltados ──
// Recibe los ids elegidos (online: los manda el servidor en sim_info; null = ninguno único)
export function buildOriginDestMarkers(scene, originId, destId) {
  POINTS.forEach(p => {
    const n = NODES[p.node]
    const isOrigin = p.id === originId
    const isDest = p.id === destId
    const catColor = new THREE.Color(CATEGORIES[p.cat].color)
    const color = isOrigin ? new THREE.Color(0x34d399) : isDest ? new THREE.Color(0xf87171) : catColor
    const h = isOrigin || isDest ? 7 : 3.6
    const r = isOrigin || isDest ? 2.4 : 1.5
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, h, 14),
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: isOrigin || isDest ? 0.55 : 0.3 })
    )
    mesh.position.set(n.x, h / 2, n.z)
    scene.add(mesh)
    // Etiqueta con el id del punto (T1, H2…) junto al marcador
    const lbl = makeLabel(p.id, { size: 6, bold: true, color: CATEGORIES[p.cat].color, opacity: 1 })
    lbl.position.set(n.x + 7, 0.09, n.z - 7)
    scene.add(lbl)
  })
}

// ── Ruta PUNTEADA sobre nodos ya resueltos (la "ruta viva" del vehículo personal) ──
// A diferencia de buildRoute, NO calcula nada: recibe la ruta del SERVIDOR, que es el
// único que tiene el grafo con las zonas rojas de Spark penalizadas y los tramos
// bloqueados por incidentes. Calcularla acá daría la ruta ideal otra vez — que es,
// justamente, la que ya dibuja buildRoute en sólido.
//
// Se dibuja con quads y no con LineDashedMaterial porque una línea de 1 px se pierde
// desde la cámara conductor, que es exactamente desde donde hay que verla.
// Devuelve un Mesh (o null si la ruta no da para dibujar); el llamador lo agrega a la
// escena y se encarga de liberarlo.
const DASH_LEN = 6, DASH_GAP = 4, DASH_W = 1.1
// y: por encima de la ruta sólida (0.15) y por debajo de las zonas rojas (0.5), que
// son translúcidas: la punteada se ve a través de la zona en vez de taparla.
const DASH_Y = 0.28

export function buildDashedRoute(nodes, color = 0x22d3ee) {
  if (!nodes || nodes.length < 2) return null
  const geoms = []
  // El patrón dash/gap se arrastra de un tramo al siguiente: sin esto cada cruce
  // reiniciaría el punteado y la ruta se vería con los guiones amontonados en las
  // esquinas.
  let carry = 0
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = NODES[nodes[i]], b = NODES[nodes[i + 1]]
    if (!a || !b) continue
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz)
    if (!len) continue
    const ux = dx / len, uz = dz / len
    const angle = -Math.atan2(dx, dz)
    let s = carry
    while (s < len) {
      const e = Math.min(s + DASH_LEN, len)
      if (e - s > 0.5) {   // un guion más corto que esto es basura visual
        const geo = new THREE.PlaneGeometry(DASH_W, e - s)
        geo.rotateX(-Math.PI / 2)
        geo.rotateY(angle)
        geo.translate(a.x + ux * (s + e) / 2, DASH_Y, a.z + uz * (s + e) / 2)
        geoms.push(geo)
      }
      s = e + DASH_GAP
    }
    carry = Math.max(0, s - len)
  }
  if (!geoms.length) return null
  return new THREE.Mesh(
    mergeGeometries(geoms, false),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
  )
}

// ── Calcula y dibuja la ruta Dijkstra entre el origen y el destino elegidos.
//    `color` opcional: en modo online cada flota se pinta del color de su dueño.
//    Corre sobre el grafo LIMPIO (dijkstra sin state): es la ruta ideal, la más
//    rápida COMO SI no hubiera eventos. La contraparte viva es buildDashedRoute. ──
export function buildRoute(scene, originPid, destPid, color = 0x60a5fa) {
  const startId = pointNode(originPid)
  const goalId = pointNode(destPid)
  const path = dijkstra(startId, goalId)
  if (!path) return null

  const mat = new THREE.MeshBasicMaterial({ color })
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

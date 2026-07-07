// ════════════════════════════════════════════════════════════════
//  GRAFO DEL MAPA — Cuadrícula 16 carreras × 13 calles (Galerías/Chapinero)
//  Fuente de verdad de coordenadas para TODAS las vistas.
//  1 unidad ≈ 4 m. X = oeste→este (carreras). Z = sur→norte (calles).
//  Separación uniforme de 30 unidades. SIN diagonales ni transversales.
// ════════════════════════════════════════════════════════════════

export const UNIT_TO_METERS = 4
export const GRID_STEP = 30

// ── CALLES (horizontales, eje Z) — de sur (Z alto) a norte (Z bajo) ──
// index = ri (row index), parte del id de nodo `${ci}_${ri}`
// `big` = rótulo grande en el borde del mapa (estilo Google Maps)
export const CALLES = [
  { name: 'Calle 45', z: 180, avenida: true, big: 'CALLE 45' },  // límite sur
  { name: 'Calle 46', z: 150 },
  { name: 'Calle 47', z: 120 },
  { name: 'Calle 48', z: 90 },
  { name: 'Calle 49', z: 60 },
  { name: 'Calle 50', z: 30 },
  { name: 'Calle 51', z: 0 },
  { name: 'Calle 52', z: -30 },
  { name: 'Calle 53', z: -60 },
  { name: 'Calle 54', z: -90 },
  { name: 'Calle 55', z: -120 },
  { name: 'Calle 56', z: -150 },
  { name: 'Calle 57', z: -180, avenida: true, big: 'CALLE 57' }, // límite norte
]

// ── CARRERAS (verticales, eje X) — de oeste (X bajo) a este (X alto) ──
// index = ci (column index). No existe Cra 29: el salto Cra30→Cra28 es normal.
export const CARRERAS = [
  { name: 'Carrera 30', x: -225, avenida: true, big: 'AVENIDA 30' }, // límite oeste
  { name: 'Carrera 28', x: -195 },
  { name: 'Carrera 27', x: -165 },
  { name: 'Carrera 26', x: -135 },
  { name: 'Carrera 25', x: -105 },
  { name: 'Carrera 24', x: -75 },
  { name: 'Carrera 23', x: -45 },
  { name: 'Carrera 22', x: -15 },
  { name: 'Carrera 21', x: 15 },
  { name: 'Carrera 20', x: 45 },
  { name: 'Carrera 19', x: 75 },
  { name: 'Carrera 18', x: 105 },
  { name: 'Carrera 17', x: 135 },
  { name: 'Carrera 16', x: 165 },
  { name: 'Carrera 15', x: 195 },
  { name: 'Carrera 14', x: 225, avenida: true, big: 'CARACAS' },    // límite este
]

// ── NODOS — una intersección por cada (carrera, calle): 16 × 13 = 208 ──
export const NODES = {}
CARRERAS.forEach((cr, ci) => CALLES.forEach((cl, ri) => {
  NODES[`${ci}_${ri}`] = {
    id: `${ci}_${ri}`, x: cr.x, z: cl.z, ci, ri,
    craName: cr.name, clName: cl.name,
  }
}))

// ── GRAFO — lista de adyacencia. Solo vecinos ortogonales (malla pura).
//    La ESTRUCTURA es inmutable y compartida; el estado mutable (bloqueos,
//    penalizaciones) vive en un EdgeState aparte para que cada simulación
//    (cada sala del servidor) tenga el suyo sin interferir con las demás. ──
export const GRAPH = {}
const edgeKey = (aId, bId) => (aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`)
function addEdge(aId, bId, kind) {
  const na = NODES[aId], nb = NODES[bId]
  const w = Math.hypot(na.x - nb.x, na.z - nb.z)
  const key = edgeKey(aId, bId)
  ;(GRAPH[aId] ||= []).push({ to: bId, w, kind, key })
  ;(GRAPH[bId] ||= []).push({ to: aId, w, kind, key })
}
CARRERAS.forEach((cr, ci) => CALLES.forEach((cl, ri) => {
  if (ci < CARRERAS.length - 1) addEdge(`${ci}_${ri}`, `${ci + 1}_${ri}`, 'calle')    // tramo horizontal
  if (ri < CALLES.length - 1)   addEdge(`${ci}_${ri}`, `${ci}_${ri + 1}`, 'carrera')  // tramo vertical
}))

// ── CATEGORÍAS de los puntos de interés (colores de la vista 2D y marcadores 3D) ──
export const CATEGORIES = {
  transporte: { label: 'Transporte',        color: '#ef4444' },
  hospital:   { label: 'Hospitales',        color: '#22c55e' },
  ecci:       { label: 'Sede ECCI',         color: '#ec4899' },
  comercial:  { label: 'Centro Comercial',  color: '#1d4ed8' },
}

// ── 15 PUNTOS FIJOS de origen/destino, en su cruce exacto ──
export const POINTS = [
  { id: 'T1', name: 'Estación Campín',      node: '0_10',  cat: 'transporte' }, // Cra30×Cl55
  { id: 'T2', name: 'Estación U. Nacional', node: '0_2',   cat: 'transporte' }, // Cra30×Cl47
  { id: 'T3', name: 'Estación Marly',       node: '15_12', cat: 'transporte' }, // Cra14×Cl57
  { id: 'T4', name: 'Estación Calle 57',    node: '15_3',  cat: 'transporte' }, // Cra14×Cl48
  { id: 'H1', name: 'EPS Sanitas',          node: '5_6',   cat: 'hospital' },   // Cra24×Cl51
  { id: 'H2', name: 'Clínica Palermo',      node: '7_3',   cat: 'hospital' },   // Cra22×Cl48
  { id: 'H3', name: 'Clínica Cafam',        node: '14_6',  cat: 'hospital' },   // Cra15×Cl51
  { id: 'H4', name: 'Hospital Verde',       node: '15_5',  cat: 'hospital' },   // Cra14×Cl50
  { id: 'H5', name: 'Clínica Marly',        node: '15_2',  cat: 'hospital' },   // Cra14×Cl47
  { id: 'E1', name: 'Sede P',               node: '9_6',   cat: 'ecci' },       // Cra20×Cl51
  { id: 'E2', name: 'Sede Principal',       node: '10_4',  cat: 'ecci' },       // Cra19×Cl49
  { id: 'E3', name: 'Sede G',               node: '10_2',  cat: 'ecci' },       // Cra19×Cl47
  { id: 'E4', name: 'Sede Jurídica',        node: '14_4',  cat: 'ecci' },       // Cra15×Cl49
  { id: 'C1', name: 'Galerías',             node: '2_8',   cat: 'comercial' },  // Cra27×Cl53
  { id: 'C2', name: 'Éxito',                node: '15_8',  cat: 'comercial' },  // Cra14×Cl53
]

export function pointNode(pointId) {
  return POINTS.find(p => p.id === pointId)?.node ?? null
}

// ── ESTADO DE ARISTAS — bloqueos (incidentes) y penalizaciones (zonas rojas).
//    createEdgeState() da uno nuevo por simulación (una por sala en el server);
//    DEFAULT_EDGE_STATE es el del cliente offline (comportamiento de siempre). ──
export function createEdgeState() {
  return { blocked: new Set(), penalty: new Map() }   // claves: edgeKey(a,b)
}
export const DEFAULT_EDGE_STATE = createEdgeState()

// ── DIJKSTRA — ruta más corta respetando bloqueos y penalizaciones del estado dado ──
export function dijkstra(startId, goalId, state = DEFAULT_EDGE_STATE) {
  const dist = {}, prev = {}, visited = {}
  for (const id in NODES) dist[id] = Infinity
  dist[startId] = 0
  const pq = [{ id: startId, d: 0 }]
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d)
    const { id } = pq.shift()
    if (visited[id]) continue
    visited[id] = true
    if (id === goalId) break
    for (const e of (GRAPH[id] || [])) {
      if (state.blocked.has(e.key)) continue
      const nd = dist[id] + e.w + (state.penalty.get(e.key) || 0)
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = id; pq.push({ id: e.to, d: nd }) }
    }
  }
  if (prev[goalId] === undefined && goalId !== startId) return null
  const path = []; let cur = goalId
  while (cur !== undefined) { path.unshift(cur); cur = prev[cur] }
  return path[0] === startId ? path : null
}

export function pathLengthUnits(path) {
  let d = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = NODES[path[i]], b = NODES[path[i + 1]]
    d += Math.hypot(a.x - b.x, a.z - b.z)
  }
  return d
}

export function setEdgeBlocked(aId, bId, blocked, state = DEFAULT_EDGE_STATE) {
  const key = edgeKey(aId, bId)
  if (blocked) state.blocked.add(key)
  else state.blocked.delete(key)
}

// Consulta rápida usada por los avatares para NO entrar a un tramo con incidente
export function isEdgeBlocked(aId, bId, state = DEFAULT_EDGE_STATE) {
  return state.blocked.has(edgeKey(aId, bId))
}

export function setEdgePenalty(aId, bId, penalty, state = DEFAULT_EDGE_STATE) {
  const key = edgeKey(aId, bId)
  if (penalty) state.penalty.set(key, penalty)
  else state.penalty.delete(key)
}

// Limpia bloqueos y penalizaciones de un estado. El DEFAULT es compartido por las
// vistas offline: si una simulación termina con un incidente activo y el usuario
// navega fuera antes de que expire, quedaría "pegado" para la siguiente. Se llama
// al arrancar cada simulación offline como red de seguridad.
export function resetGraph(state = DEFAULT_EDGE_STATE) {
  state.blocked.clear()
  state.penalty.clear()
}

// Lista plana de todas las aristas únicas del grafo (cada una una sola vez, sin duplicar a↔b)
export function allEdges() {
  const seen = new Set(), edges = []
  for (const aId in GRAPH) {
    for (const e of GRAPH[aId]) {
      const key = [aId, e.to].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ a: aId, b: e.to })
    }
  }
  return edges
}

export function nearestNode(x, z) {
  let best = null, bd = Infinity
  for (const id in NODES) {
    const n = NODES[id]
    const d = Math.hypot(n.x - x, n.z - z)
    if (d < bd) { bd = d; best = id }
  }
  return best
}

// Límites del mapa completo, usados por cámara 2D y el grid de zonas de analítica
export const MAP_BOUNDS = {
  xMin: -225, xMax: 225,
  zMin: -180, zMax: 180,
}

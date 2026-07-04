// ════════════════════════════════════════════════════════════════
//  GRAFO DEL MAPA — Sector Galerías/Chapinero, Bogotá
//  Fuente de verdad de coordenadas para TODAS las vistas.
//  1 unidad ≈ 4 metros. X = oeste→este (carreras). Z = sur→norte (calles).
// ════════════════════════════════════════════════════════════════

export const UNIT_TO_METERS = 4

// ── CALLES (horizontales, eje Z) — de sur (Z alto) a norte (Z bajo) ──
// index = ri (row index), usado como parte del id de nodo `${ci}_${ri}`
export const CALLES = [
  { name: 'Cl 45',  z: 200, avenida: true },  // límite sur
  { name: 'Cl 45A', z: 184 },
  { name: 'Cl 46',  z: 168 },
  { name: 'Cl 47',  z: 152 },
  { name: 'Cl 48',  z: 136 },
  { name: 'Cl 50',  z: 112 },
  { name: 'Cl 51',  z: 88 },
  { name: 'Cl 52',  z: 64 },
  { name: 'Cl 53',  z: 36, avenida: true },   // AC 53
  { name: 'Cl 54',  z: 8 },
  { name: 'Cl 55',  z: -20 },
  { name: 'Cl 56',  z: -48 },
  { name: 'Cl 57',  z: -80, avenida: true },  // límite norte
]

// ── CARRERAS (verticales, eje X) — de oeste (X bajo) a este (X alto) ──
// index = ci (column index)
export const CARRERAS = [
  { name: 'Av 30',      x: -180, avenida: true }, // límite oeste
  { name: 'Cra 28A',    x: -150 },
  { name: 'Cra 28',     x: -128 },
  { name: 'Cra 27',     x: -104 },
  { name: 'Cra 26',     x: -80 },
  { name: 'Cra 25',     x: -56 },
  { name: 'Cra 24',     x: -32 },
  { name: 'Cra 23',     x: -8 },
  { name: 'Cra 22',     x: 16 },
  { name: 'Cra 21',     x: 40 },
  { name: 'Cra 20',     x: 64 },
  { name: 'Cra 19',     x: 90, avenida: true },  // Av Carrera 19
  { name: 'Cra 17',     x: 118 },
  { name: 'Cra 16',     x: 144 },
  { name: 'Cra 15',     x: 170 },
  { name: 'Av Caracas', x: 200, avenida: true }, // límite este
]

// ── NODOS — una intersección real por cada (carrera, calle) ──
export const NODES = {}
CARRERAS.forEach((cr, ci) => CALLES.forEach((cl, ri) => {
  NODES[`${ci}_${ri}`] = {
    id: `${ci}_${ri}`, x: cr.x, z: cl.z, ci, ri,
    craName: cr.name, clName: cl.name,
  }
}))

// ── GRAFO — lista de adyacencia. Cada arista = tramo de calle/carrera/diagonal ──
export const GRAPH = {}
function addEdge(aId, bId, kind = 'grid') {
  const na = NODES[aId], nb = NODES[bId]
  const w = Math.hypot(na.x - nb.x, na.z - nb.z)
  ;(GRAPH[aId] ||= []).push({ to: bId, w, baseW: w, blocked: false, penalty: 0, kind })
  ;(GRAPH[bId] ||= []).push({ to: aId, w, baseW: w, blocked: false, penalty: 0, kind })
}

// Malla base: cada calle conecta carreras consecutivas, cada carrera conecta calles consecutivas
CARRERAS.forEach((cr, ci) => CALLES.forEach((cl, ri) => {
  if (ci < CARRERAS.length - 1) addEdge(`${ci}_${ri}`, `${ci + 1}_${ri}`, 'calle')
  if (ri < CALLES.length - 1)   addEdge(`${ci}_${ri}`, `${ci}_${ri + 1}`, 'carrera')
}))

// ── DIAGONALES Y TRANSVERSALES — atajos que cruzan la malla en ángulo ──
// Nota: "Cra 18" (Diagonal 48) no existe en la lista de carreras del enunciado;
// se aproxima al nodo real más cercano (Cra 17) para no inventar una carrera nueva.
// Transversal 19 Bis/20 está descrita de forma vaga ("zona sureste cerca de Av Calle 42");
// se interpreta como dos conectores cortos entre Cra 19 y Cra 20, entre Cl 45 y Cl 48.
const DIAGONALS = [
  { name: 'Av Calle 42 / Caracas', a: '8_0',  b: '13_5' },  // Cra22×Cl45 → Cra16×Cl50
  { name: 'Diagonal 46',           a: '10_4', b: '12_5' },  // Cra20×Cl48 → Cra17×Cl50
  { name: 'Diagonal 48',           a: '9_3',  b: '12_5' },  // Cra21×Cl47 → (~Cra18×Cl50 ≈ Cra17×Cl50)
  { name: 'Diagonal 53D/53C',      a: '3_8',  b: '6_10' },  // Cra27×Cl53 → Cra24×Cl55
  { name: 'Diagonal 54',           a: '9_9',  b: '14_11' }, // Cra21×Cl54 → Cra15×Cl56
  { name: 'Transversal 24',        a: '6_10', b: '8_12' },  // Cra24×Cl55 → Cra22×Cl57
  { name: 'Transversal 27',        a: '3_8',  b: '4_10' },  // Cra27×Cl53 → Cra26×Cl55
  { name: 'Transversal 28',        a: '2_8',  b: '3_10' },  // Cra28×Cl53 → Cra27×Cl55
  { name: 'Transversal 19 Bis',    a: '11_0', b: '10_3' },  // Cra19×Cl45 → Cra20×Cl47 (aprox.)
  { name: 'Transversal 20',        a: '10_0', b: '11_4' },  // Cra20×Cl45 → Cra19×Cl48 (aprox.)
]
DIAGONALS.forEach(d => addEdge(d.a, d.b, 'diagonal'))
export { DIAGONALS }

// ── 15 PUNTOS FIJOS de origen/destino seleccionables ──
export const POINTS = [
  { id: 'P1',  name: 'Estadio El Campín',       node: '0_12' },
  { id: 'P2',  name: 'Galerías',                node: '2_8' },
  { id: 'P3',  name: 'Av 30 con Cl 51',         node: '0_6' },
  { id: 'P4',  name: 'Cra 24 con Cl 52',        node: '6_7' },
  { id: 'P5',  name: 'Parque (Cra 22 × Cl 50)', node: '8_5' },
  { id: 'P6',  name: 'Av Caracas × Cl 57',      node: '15_12' },
  { id: 'P7',  name: 'Chapinero (Cra 15×Cl 48)',node: '14_4' },
  { id: 'P8',  name: 'U. Católica (Cra16×Cl47)',node: '13_3' },
  { id: 'P9',  name: 'Cra 20 con Cl 53',        node: '10_8' },
  { id: 'P10', name: 'Cra 19 con Cl 50',        node: '11_5' },
  { id: 'P11', name: 'Av Calle 42 (SO)',        node: '8_0' },
  { id: 'P12', name: 'Cra 17 con Cl 45',        node: '12_0' },
  { id: 'P13', name: 'Cl 56 con Cra 21',        node: '9_11' },
  { id: 'P14', name: 'Cra 26 con Cl 48',        node: '4_4' },
  { id: 'P15', name: 'Av Caracas × Cl 50',      node: '15_5' },
]

export function pointNode(pointId) {
  return POINTS.find(p => p.id === pointId)?.node ?? null
}

// ── DIJKSTRA — ruta más corta respetando bloqueos y penalizaciones por zona roja ──
export function dijkstra(startId, goalId) {
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
      if (e.blocked) continue
      const nd = dist[id] + e.w + e.penalty
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

export function setEdgeBlocked(aId, bId, blocked) {
  for (const e of (GRAPH[aId] || [])) if (e.to === bId) e.blocked = blocked
  for (const e of (GRAPH[bId] || [])) if (e.to === aId) e.blocked = blocked
}

export function setEdgePenalty(aId, bId, penalty) {
  for (const e of (GRAPH[aId] || [])) if (e.to === bId) e.penalty = penalty
  for (const e of (GRAPH[bId] || [])) if (e.to === aId) e.penalty = penalty
}

// Reinicia TODAS las aristas a su estado original (sin bloqueos ni penalizaciones).
// GRAPH es un módulo compartido por toda la app: si una simulación termina con un
// incidente activo o una zona roja y el usuario navega fuera antes de que expiren,
// ese bloqueo/penalización quedaría "pegado" para la siguiente simulación. Se llama
// al arrancar cada simulación nueva como red de seguridad (además de que cada
// dispose() ya limpia lo suyo).
export function resetGraph() {
  for (const id in GRAPH) for (const e of GRAPH[id]) { e.blocked = false; e.penalty = 0 }
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
  xMin: -180, xMax: 200,
  zMin: -80,  zMax: 200,
}

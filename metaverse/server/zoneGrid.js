// ════════════════════════════════════════════════════════════════
//  MAPEO DE ZONA (server) — réplica PURA de zoneIndexAt() de
//  src/analytics/zones.js, SIN importar three.js (que es solo del
//  navegador). Traduce coordenadas de mundo (x,z) al índice de la
//  cuadrícula 6×6, para que el consumidor de `red-points` convierta el
//  centro de la celda de Spark en el índice de zona del overlay.
//
//  MAP_BOUNDS y GRID_SIZE se importan de módulos puros (mapData.js /
//  analytics/config.js): ninguno arrastra three.js.
// ════════════════════════════════════════════════════════════════
import { MAP_BOUNDS } from '../src/graph/mapData.js'
import { ANALYTICS_CONFIG as CFG } from '../src/analytics/config.js'

export const GRID_SIZE = CFG.GRID_SIZE

// Índice de zona 0..(GRID_SIZE²-1) a partir de coordenadas de mundo.
// x = eje three.js X (carreras), z = eje three.js Z (calles / plano de piso).
export function zoneIndexAt(x, z) {
  const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
  const cw = (xMax - xMin) / GRID_SIZE, ch = (zMax - zMin) / GRID_SIZE
  let zx = Math.floor((x - xMin) / cw), zz = Math.floor((z - zMin) / ch)
  zx = Math.max(0, Math.min(GRID_SIZE - 1, zx))
  zz = Math.max(0, Math.min(GRID_SIZE - 1, zz))
  return zz * GRID_SIZE + zx
}

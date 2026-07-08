// ════════════════════════════════════════════════════════════════
//  MAPEO DE ZONA (server) — réplica PURA de zoneIndexAt() de
//  src/analytics/zones.js, SIN importar three.js (que es solo del
//  navegador). Traduce coordenadas de mundo (x,z) al índice de la
//  cuadrícula de zonas, para que el consumidor de `red-points`
//  convierta el centro de la celda de Spark en el índice del overlay.
//
//  La grilla (origen, tamaño de celda, columnas×filas) viene de
//  ANALYTICS_CONFIG: anclada a mitad de manzana para que ninguna vía
//  caiga sobre un borde de celda (ver el comentario en config.js).
// ════════════════════════════════════════════════════════════════
import { ANALYTICS_CONFIG as CFG } from '../src/analytics/config.js'

export const GRID_COLS = CFG.GRID_COLS
export const GRID_ROWS = CFG.GRID_ROWS

// Índice de zona 0..(GRID_COLS·GRID_ROWS - 1) a partir de coordenadas de mundo.
// x = eje three.js X (carreras), z = eje three.js Z (calles / plano de piso).
export function zoneIndexAt(x, z) {
  let zx = Math.floor((x - CFG.ZONE_ORIGIN_X) / CFG.ZONE_CELL)
  let zz = Math.floor((z - CFG.ZONE_ORIGIN_Z) / CFG.ZONE_CELL)
  zx = Math.max(0, Math.min(CFG.GRID_COLS - 1, zx))
  zz = Math.max(0, Math.min(CFG.GRID_ROWS - 1, zz))
  return zz * CFG.GRID_COLS + zx
}

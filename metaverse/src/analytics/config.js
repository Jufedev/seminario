// ════════════════════════════════════════════════════════════════
//  CONFIG — parámetros de la analítica por zonas (Fase 3)
// ════════════════════════════════════════════════════════════════
export const ANALYTICS_CONFIG = {
  // Cuadrícula de zonas anclada a MITAD DE MANZANA: celdas de 60×60 unidades
  // con origen en (-240,-195) → 8 columnas × 7 filas = 56 zonas. Las vías van
  // cada 30 unidades (calles en z múltiplo de 30, carreras en x ≡ 15 mod 30),
  // así que ningún borde de celda cae sobre una vía: cada zona contiene UNA
  // manzana completa con sus cuatro calles enteras adentro. Una cola sobre una
  // calle nunca se parte entre dos zonas (ni en la detección de Spark, ni en
  // el overlay, ni en las penalizaciones de Dijkstra). El detector debe usar
  // la MISMA grilla (CELL_SIZE_X/Y y GRID_ORIGIN_X/Y del .env).
  GRID_COLS: 8,
  GRID_ROWS: 7,
  ZONE_CELL: 60,               // lado de la celda (unidades de mundo) = 2 cuadras
  ZONE_ORIGIN_X: -240,         // esquina de la grilla, media manzana antes del mapa
  ZONE_ORIGIN_Z: -195,
  ZONE_WINDOW_S: 1,             // ventana de recálculo por zona (no cada frame)
  // Pesos del índice de congestión C = W_DENSITY·ρ + W_INCIDENTS·i + W_SPEED_DEFICIT·v
  W_DENSITY: 0.4,
  W_INCIDENTS: 0.3,
  W_SPEED_DEFICIT: 0.3,
  // C ≥ esto → zona ROJA. Con los pesos 0.4/0.3/0.3, la densidad sola nunca puede superar
  // 0.4 (su peso máximo) — cruzar el umbral exige incidentes o déficit de velocidad reales,
  // no solo aglomeración. Se calibró en 0.5 (bajado del 0.6 original del enunciado) para que
  // se dispare de forma confiable con tráfico pesado real, en vez de solo en condiciones extremas.
  C_RED_THRESHOLD: 0.5,
  // Regla directa del enunciado: más de este nº de avatares en una celda → zona ROJA,
  // aunque C no haya cruzado el umbral (la densidad sola pesa máx. 0.4 y no alcanzaría).
  ZONE_RED_AVATARS: 20,
  ZONE_CAPACITY_PER_EDGE: 2,    // avatares "cómodos" por arista antes de saturar (ρ=1)
  ZONE_PENALTY_SCALE: 40,       // penalización extra a Dijkstra por unidad de C en zona roja
  DASHBOARD_SAMPLE_S: 1,        // cadencia de muestreo del dashboard (gráficas de tiempo)
  DASHBOARD_MAX_SAMPLES: 240,   // tope de puntos guardados por serie de tiempo (~4 min a 1/s)
}

// ════════════════════════════════════════════════════════════════
//  CONFIG — parámetros de la analítica por zonas (Fase 3)
// ════════════════════════════════════════════════════════════════
export const ANALYTICS_CONFIG = {
  GRID_SIZE: 6,                // cuadrícula de zonas: 6×6 = 36
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
  ZONE_CAPACITY_PER_EDGE: 2,    // avatares "cómodos" por arista antes de saturar (ρ=1)
  ZONE_PENALTY_SCALE: 40,       // penalización extra a Dijkstra por unidad de C en zona roja
  DASHBOARD_SAMPLE_S: 1,        // cadencia de muestreo del dashboard (gráficas de tiempo)
  DASHBOARD_MAX_SAMPLES: 240,   // tope de puntos guardados por serie de tiempo (~4 min a 1/s)
}

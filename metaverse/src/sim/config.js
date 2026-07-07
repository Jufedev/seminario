// ════════════════════════════════════════════════════════════════
//  CONFIG — constantes del motor de simulación
// ════════════════════════════════════════════════════════════════
// Nota (capacidad de vía): con 2 carriles por sentido y MIN_GAP centro-a-centro,
// la capacidad sostenida de una vía con semáforos es ≈ (AGENT_SPEED / MIN_GAP)
// · 2 carriles · 0.5 (fracción de verde) ≈ 1 veh/s. La frecuencia de spawn la
// decide el usuario (oleadas): pedir más que eso genera fila en el origen.
export const SIM_CONFIG = {
  MAX_AGENTS: 500,
  LANE_OFFSET: 1.6,          // separación lateral entre el eje de la vía y cada carril
  CAR_LENGTH: 2.4,           // largo del avatar (BoxGeometry) — la fila se mide contra esto
  MIN_GAP: 3.5,              // distancia mínima ENTRE CENTROS al de adelante (> CAR_LENGTH ⇒ nunca se solapan)
  SPAWN_HEADROOM: 4.5,       // hueco libre necesario en el tramo de salida para soltar otro avatar
  AGENT_SPEED: 3.6,          // velocidad crucero, unidades/seg (1 unidad ≈ 4m → ~14.4 m/s ≈ 52 km/h)
  STOP_DISTANCE: 3.5,        // distancia al nodo desde la que se evalúa semáforo/tramo bloqueado
  STUCK_TIME: 4,             // segundos sin avanzar (fuera de un semáforo en rojo) → atascado
  LIGHT_PERIOD: 8,           // segundos por fase de semáforo (corto: flujo continuo, no stop-and-go largo)
  KAFKA_SAMPLE_MS: 500,      // frecuencia del muestreo agregado de posición hacia Kafka
  INCIDENT_MIN_S: 5,         // duración mínima de un incidente
  INCIDENT_MAX_S: 20,        // duración máxima de un incidente
  INCIDENT_MAX_ACTIVE: 22,   // tope de incidentes simultáneos (evita desconectar el grafo)
}

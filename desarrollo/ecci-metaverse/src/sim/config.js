// ════════════════════════════════════════════════════════════════
//  CONFIG — constantes del motor de simulación (Fase 2)
// ════════════════════════════════════════════════════════════════
// Nota de ajuste (capacidad de vía): con 2 carriles por sentido, cada semáforo deja pasar
// tráfico en su eje solo ~50% del tiempo (ciclo verde/rojo), así que la capacidad sostenida
// de una vía con semáforos es ≈ (AGENT_SPEED / MIN_GAP) · 2 carriles · 0.5 ≈ 2 veh/s aquí.
export const SIM_CONFIG = {
  MAX_AGENTS: 500,
  SPAWN_INTERVAL_MS: 500,   // cada cuánto sale un avatar nuevo (salida escalonada) → ~2 veh/s
  LANE_OFFSET: 1.6,          // separación lateral entre el eje de la vía y cada carril
  MIN_GAP: 1.8,              // distancia mínima al vehículo de adelante (car-following)
  AGENT_SPEED: 3.6,          // velocidad crucero, unidades/seg (1 unidad ≈ 4m → ~14.4 m/s ≈ 52 km/h)
  STOP_DISTANCE: 3.5,        // distancia al nodo desde la que se evalúa el semáforo
  STUCK_TIME: 4,             // segundos sin avanzar (fuera de un semáforo en rojo) → atascado
  LIGHT_PERIOD: 15,          // segundos por fase de semáforo (sincronizado en todo el mapa)
  KAFKA_SAMPLE_MS: 500,      // frecuencia del muestreo agregado de posición hacia Kafka
  INCIDENT_MIN_S: 5,         // duración mínima de un incidente
  INCIDENT_MAX_S: 20,        // duración máxima de un incidente
  INCIDENT_MAX_ACTIVE: 22,   // tope de incidentes simultáneos (evita desconectar el grafo)
}

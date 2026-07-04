// ════════════════════════════════════════════════════════════════
//  STORE — estado compartido entre las 3 vistas (sin frameworks)
// ════════════════════════════════════════════════════════════════
export const store = {
  originId: null,      // id de POINTS elegido como origen (ej. 'P1')
  destId: null,        // id de POINTS elegido como destino
  numAvatars: 100,      // 1..500
  incidentFreq: 10,     // segundos promedio entre incidentes
  // Red-zone detection mode — the thesis experiment variable (H1):
  // 'local'    -> in-browser zone analytics (standalone, default)
  // 'pipeline' -> red zones come only from Spark via the bridge (needs VITE_BRIDGE_WS_URL)
  detectionMode: 'local',
}

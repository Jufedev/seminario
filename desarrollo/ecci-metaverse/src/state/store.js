// ════════════════════════════════════════════════════════════════
//  STORE — estado compartido entre las 3 vistas (sin frameworks)
// ════════════════════════════════════════════════════════════════
export const store = {
  originId: null,      // id de POINTS elegido como origen (ej. 'P1')
  destId: null,        // id de POINTS elegido como destino
  numAvatars: 100,      // 1..500
  incidentFreq: 10,     // segundos promedio entre incidentes
}

// ════════════════════════════════════════════════════════════════
//  RELOJ DEL CHAT EFÍMERO — una sola permanencia y un solo
//  desvanecido para las dos superficies donde aparece un mensaje: la
//  burbuja sobre el avatar (chatBubbles.js) y el anuncio del admin
//  colgado del borde de la ventana (chatBanner.js). Están en módulos
//  distintos porque una es three.js y el otro es DOM, pero para quien
//  mira la pantalla son el MISMO sistema: con los números duplicados
//  se desincronizarían en el primer ajuste.
// ════════════════════════════════════════════════════════════════
export const CHAT_DWELL_MS = 4500   // cuánto se queda el mensaje…
export const CHAT_FADE_MS = 800     // …y el desvanecido con el que se va

// Opacidad según la edad del mensaje (ms desde que se mostró): opaco hasta los
// últimos CHAT_FADE_MS y de ahí, lineal, a cero.
// Pura y exportada para poder testearla: es lo único de la animación que se
// puede verificar sin navegador ni WebGL.
export function chatOpacity(ageMs) {
  return Math.max(0, Math.min(1, (CHAT_DWELL_MS - ageMs) / CHAT_FADE_MS))
}

// El mensaje ya cumplió su tiempo: hay que retirarlo (el historial lo conserva).
export function chatExpired(ageMs) {
  return ageMs > CHAT_DWELL_MS
}

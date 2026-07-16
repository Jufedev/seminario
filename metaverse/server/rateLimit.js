// Piso de tiempo entre mensajes de un mismo socket — módulo PURO (el reloj entra
// por parámetro, así el test no depende de esperas reales).
//
// Es la forma que le sirve a drive_intent: el ChatRateLimiter de chat.js cuenta
// mensajes en una ventana (5 en 5 s), pensado para texto que se lee. Una intención
// de giro es un evento discreto por cruce (~1 cada 8 s): lo único que hay que
// impedir es que un cliente roto convierta el canal en un flujo continuo, y para
// eso basta con un piso entre mensajes consecutivos.
export class MinIntervalLimiter {
  constructor(minMs) { this.minMs = minMs; this.last = -Infinity }

  allow(now = Date.now()) {
    if (now - this.last < this.minMs) return false
    this.last = now
    return true
  }
}

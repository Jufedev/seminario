// ════════════════════════════════════════════════════════════════
//  CHAT DE SALA — módulo PURO: normaliza el texto entrante y arma el
//  mensaje que se difunde. El emisor NUNCA se toma del cliente: el
//  slot y el nombre salen de la sala, igual que el resto del protocolo.
//  Efímero por diseño: no hay historial en el servidor. Lo que no
//  alcanza el broadcast se pierde, y con la sala mueren los mensajes.
//  NO se publica a Kafka: el chat no es fuente del pipeline (no lo ven
//  ni el detector ni la analítica).
// ════════════════════════════════════════════════════════════════

export const MAX_CHAT_LEN = 200     // tope duro del texto, ya recortado
const RATE_WINDOW_MS = 5000         // ventana del limitador de inundación…
const RATE_MAX_MSGS = 5             // …y cuántos mensajes admite dentro de ella

// Texto de UNA línea, recortado y con tope. \p{C} barre controles y caracteres
// de formato (saltos, tabuladores, ancho cero): romperían la burbuja 3D o la
// dejarían ilegible, así que se colapsan a espacios antes de recortar.
export function sanitizeChatText(raw) {
  return String(raw ?? '')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LEN)
}

// Mensaje autoritativo listo para difundir, o null si no hay nada que decir
// (texto vacío) o si el emisor ya no figura en la sala. `sender` es el rol/slot
// que el servidor le asignó al socket en el join, no lo que diga el mensaje.
export function buildChatMessage(room, { role, slot }, raw) {
  const text = sanitizeChatText(raw)
  if (!text) return null
  const name = role === 'admin' ? room.adminName : room.users[slot - 1]?.name
  if (!name) return null
  return { type: 'chat_message', slot: role === 'admin' ? 0 : slot, name, text, ts: Date.now() }
}

// Higiene de inundación por socket: ventana deslizante corta. Son 3 usuarios y
// un admin por sala, así que no hace falta nada más elaborado.
export class ChatRateLimiter {
  constructor() { this.times = [] }

  allow(now = Date.now()) {
    while (this.times.length && now - this.times[0] > RATE_WINDOW_MS) this.times.shift()
    if (this.times.length >= RATE_MAX_MSGS) return false
    this.times.push(now)
    return true
  }
}

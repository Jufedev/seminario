// Tests del chat de sala (bun test — sin Kafka ni navegador).
// Blindan lo único que el servidor NO puede delegarle al cliente:
//  · atribución: el emisor sale de la sala, nunca del mensaje,
//  · tope de longitud y saneado del texto (va al DOM y a una etiqueta 3D),
//  · alcance: un chat_message no puede cruzar de sala,
//  · higiene de inundación.
import { describe, expect, test } from 'bun:test'
import { Room } from '../server/rooms.js'
import { buildChatMessage, sanitizeChatText, ChatRateLimiter, MAX_CHAT_LEN } from '../server/chat.js'
import { wrapLines, staleChatSlots } from '../src/views/chatBubbles.js'
import { chatOpacity, chatExpired, CHAT_DWELL_MS, CHAT_FADE_MS } from '../src/views/chatTiming.js'

// La simulación de cada sala hace console.debug de sus eventos; se silencia
// igual que en server/index.js.
console.debug = () => {}

// ws de mentira: solo lo que mira Room.broadcast (readyState + send)
function fakeWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)) } }
}
const chats = ws => ws.sent.filter(m => m.type === 'chat_message')

describe('atribución (el emisor lo pone la sala, no el cliente)', () => {
  test('un usuario habla con SU slot y SU nombre', () => {
    const room = new Room('ECCI-0001')
    const slot = room.joinUser(fakeWs(), 'Beto')
    expect(buildChatMessage(room, { role: 'user', slot }, 'hola')).toEqual({
      type: 'chat_message', slot: 1, name: 'Beto', text: 'hola', ts: expect.any(Number),
    })
  })

  // El nombre lo resuelve la sala: renombrar el cliente no renombra al emisor.
  test('el nombre viene de la sala, no de lo que traiga el mensaje', () => {
    const room = new Room('ECCI-0001')
    room.joinUser(fakeWs(), 'Beto')
    const msg = buildChatMessage(room, { role: 'user', slot: 1 }, 'hola')
    expect(msg.name).toBe('Beto')
    expect(msg.slot).toBe(1)
  })

  test('un slot vacío no habla (usuario que ya salió)', () => {
    const room = new Room('ECCI-0001')
    expect(buildChatMessage(room, { role: 'user', slot: 2 }, 'hola')).toBeNull()
  })

  test('el admin habla como slot 0', () => {
    const room = new Room('ECCI-0001')
    room.joinAdmin(fakeWs(), 'Ana')
    const msg = buildChatMessage(room, { role: 'admin', slot: 0 }, 'hola')
    expect(msg.slot).toBe(0)
    expect(msg.name).toBe('Ana')
  })

  test('sin admin en la sala, nadie habla como admin', () => {
    const room = new Room('ECCI-0001')
    expect(buildChatMessage(room, { role: 'admin', slot: 0 }, 'hola')).toBeNull()
  })
})

describe('saneado del texto (va al DOM y a una etiqueta 3D)', () => {
  test('recorta al tope duro de longitud', () => {
    const room = new Room('ECCI-0001')
    room.joinUser(fakeWs(), 'Beto')
    const msg = buildChatMessage(room, { role: 'user', slot: 1 }, 'x'.repeat(MAX_CHAT_LEN * 3))
    expect(msg.text.length).toBe(MAX_CHAT_LEN)
  })

  test('un mensaje vacío o en blanco no se difunde', () => {
    const room = new Room('ECCI-0001')
    room.joinUser(fakeWs(), 'Beto')
    for (const raw of ['', '   ', null, undefined]) {
      expect(buildChatMessage(room, { role: 'user', slot: 1 }, raw)).toBeNull()
    }
  })

  // Saltos y tabuladores romperían la burbuja: se colapsan a una sola línea.
  test('los caracteres de control se colapsan a espacios', () => {
    const NL = String.fromCharCode(10), TAB = String.fromCharCode(9), NUL = String.fromCharCode(0)
    expect(sanitizeChatText(`a${NL}b${TAB}c${NUL}d`)).toBe('a b c d')
  })

  test('el texto legítimo sobrevive intacto (acentos, signos, emoji)', () => {
    expect(sanitizeChatText('¿Qué tal? áéíóú ñ 🚗')).toBe('¿Qué tal? áéíóú ñ 🚗')
  })

  // No se escapa aquí: el escape es del consumidor (textContent / fillText).
  // Lo que se blinda es que el servidor no invente ni pierda texto.
  test('el texto se difunde literal (el escape es del cliente)', () => {
    expect(sanitizeChatText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('alcance (el chat es de la sala)', () => {
  test('llega a los miembros de SU sala, admin incluido, y a nadie más', () => {
    const a = new Room('ECCI-0001')
    const b = new Room('ECCI-0002')
    const wsUserA = fakeWs(), wsAdminA = fakeWs(), wsUserB = fakeWs()
    a.joinUser(wsUserA, 'Beto')
    a.joinAdmin(wsAdminA, 'Ana')
    b.joinUser(wsUserB, 'Caro')

    const msg = buildChatMessage(a, { role: 'user', slot: 1 }, 'hola')
    a.broadcast(msg)

    expect(chats(wsUserA)).toEqual([msg])
    expect(chats(wsAdminA)).toEqual([msg])   // el admin observa el chat de la sala
    expect(chats(wsUserB)).toEqual([])       // otra sala: ni se entera
  })

  test('quien salió de la sala deja de recibir', () => {
    const room = new Room('ECCI-0001')
    const ws = fakeWs()
    room.joinUser(ws, 'Beto')
    room.leave(ws)
    room.broadcast({ type: 'chat_message', slot: 2, name: 'Caro', text: 'hola', ts: Date.now() })
    expect(chats(ws)).toEqual([])
  })
})

// El texto máximo del servidor (200) no cabe entero sobre un avatar: la burbuja
// se recorta para no tapar el mapa. El historial sí conserva el mensaje completo.
describe('recorte de la burbuja (wrapLines)', () => {
  const LINE = 24, LINES = 3

  test('un mensaje corto queda en una sola línea, intacto', () => {
    expect(wrapLines('hola')).toEqual(['hola'])
  })

  test('parte por palabras, sin cortarlas a la mitad', () => {
    for (const l of wrapLines('el trancón de la carrera treinta esta tremendo hoy')) {
      expect(l.length).toBeLessThanOrEqual(LINE)
    }
    expect(wrapLines('el trancón de la carrera treinta').join(' ')).toBe('el trancón de la carrera treinta')
  })

  test('el tope del servidor nunca produce más de 3 líneas', () => {
    const lines = wrapLines('x'.repeat(MAX_CHAT_LEN))
    expect(lines.length).toBe(LINES)
    expect(lines.at(-1).endsWith('…')).toBe(true)
  })

  test('ninguna línea excede el ancho, ni con una palabra kilométrica', () => {
    for (const l of wrapLines('a'.repeat(MAX_CHAT_LEN))) {
      expect(l.length).toBeLessThanOrEqual(LINE)
    }
  })

  test('lo que cabe justo no se recorta', () => {
    const lines = wrapLines('ab '.repeat(20).trim())
    expect(lines.length).toBeLessThanOrEqual(LINES)
    expect(lines.join(' ')).toBe('ab '.repeat(20).trim())
  })
})

// El servidor recicla el slot libre más bajo (rooms.js joinUser), y la burbuja se
// indexa por slot: una que sobreviva a su autor apunta a una casilla que puede ser
// ya de otro. Hoy el candado de invocación tapa esa grieta —el que entra no llega a
// tener avatar en ese slot—, pero eso es un invariante ajeno al chat. Esta regla la
// cierra sin depender de él.
describe('la burbuja no sobrevive a su autor (staleChatSlots)', () => {
  test('el que se fue de la sala pierde su burbuja', () => {
    expect(staleChatSlots([1, 2, 3], [1, 3])).toEqual([2])
  })

  test('los que siguen en la sala conservan la suya', () => {
    expect(staleChatSlots([1, 2], [1, 2])).toEqual([])
  })

  test('sala vacía: no queda ninguna', () => {
    expect(staleChatSlots([1, 2, 3], [])).toEqual([1, 2, 3])
  })

  test('un slot sin burbuja no molesta', () => {
    expect(staleChatSlots([2], [1, 2, 3])).toEqual([])
  })
})

// La burbuja del avatar (three.js) y el anuncio del admin (DOM) son módulos
// distintos, pero en pantalla tienen que leerse como un solo sistema: mismo
// tiempo en pantalla y mismo desvanecido. Eso lo garantiza chatTiming.js.
describe('reloj compartido del chat (chatTiming)', () => {
  test('el mensaje recién puesto está opaco', () => {
    expect(chatOpacity(0)).toBe(1)
    expect(chatExpired(0)).toBe(false)
  })

  test('está opaco hasta que empieza el desvanecido', () => {
    expect(chatOpacity(CHAT_DWELL_MS - CHAT_FADE_MS)).toBe(1)
  })

  test('el desvanecido es lineal en su ventana', () => {
    expect(chatOpacity(CHAT_DWELL_MS - CHAT_FADE_MS / 2)).toBeCloseTo(0.5)
    expect(chatOpacity(CHAT_DWELL_MS)).toBe(0)
  })

  // Sin esto, un frame tardío (pestaña en segundo plano) dejaría opacidad
  // negativa: el sprite y el anuncio esperan un valor entre 0 y 1.
  test('nunca se sale de [0,1], ni con una edad absurda', () => {
    for (const age of [-1000, 0, CHAT_DWELL_MS * 10]) {
      expect(chatOpacity(age)).toBeGreaterThanOrEqual(0)
      expect(chatOpacity(age)).toBeLessThanOrEqual(1)
    }
  })

  test('se retira pasada la permanencia', () => {
    expect(chatExpired(CHAT_DWELL_MS)).toBe(false)
    expect(chatExpired(CHAT_DWELL_MS + 1)).toBe(true)
  })
})

describe('higiene de inundación', () => {
  test('admite una ráfaga corta y corta la que sigue', () => {
    const rl = new ChatRateLimiter()
    const burst = [1, 2, 3, 4, 5, 6].map(() => rl.allow(1000))
    expect(burst).toEqual([true, true, true, true, true, false])
  })

  test('pasada la ventana vuelve a admitir', () => {
    const rl = new ChatRateLimiter()
    for (let i = 0; i < 5; i++) rl.allow(1000)
    expect(rl.allow(1000)).toBe(false)
    expect(rl.allow(1000 + 5001)).toBe(true)
  })
})

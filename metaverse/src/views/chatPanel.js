import { session } from '../net/session.js'
import { OWNER_COLORS } from './onlineWorld.js'
import { createChatAnnounce } from './chatBanner.js'
import { wireCollapseToggle } from '../ui/collapse.js'

// ════════════════════════════════════════════════════════════════
//  PANEL DE CHAT — helper compartido por la vista de usuario y la del
//  admin: el historial reciente de la sala y la caja de envío.
//  Es SECUNDARIO: la interacción entre avatares se ve en la burbuja
//  del mundo 3D (chatBubbles.js); esto solo da contexto de lo dicho.
//  Efímero: vive en el DOM de la vista. Al salir de la sala se va con
//  ella, porque el servidor no guarda historial (ver server/chat.js).
// ════════════════════════════════════════════════════════════════
const MAX_LOG = 30   // líneas visibles; es contexto reciente, no un registro

// maxlength es solo comodidad de la caja: el tope real lo aplica el servidor.
export const CHAT_PANEL_HTML = `
  <div id="chat-panel" class="panel chat-panel">
    <div class="chat-head">
      <h3>💬 Chat de la sala</h3>
      <button id="chat-toggle" class="metrics-toggle" title="Colapsar / expandir el chat (despeja el mapa)">▾</button>
    </div>
    <div class="chat-body">
      <div id="chat-log" class="chat-log"></div>
      <form id="chat-form" class="chat-form">
        <input id="chat-text" type="text" maxlength="200" autocomplete="off" placeholder="Escribe un mensaje" />
        <button class="btn" type="submit">Enviar</button>
      </form>
    </div>
  </div>
`

// Cablea el panel: envía chat_send y pinta cada chat_message que difunde la
// sala. Devuelve la función para desuscribirse (teardown de la vista).
export function wireChatPanel(view, world) {
  const panel = view.querySelector('#chat-panel')
  const toggle = view.querySelector('#chat-toggle')
  const log = view.querySelector('#chat-log')
  const form = view.querySelector('#chat-form')
  const input = view.querySelector('#chat-text')
  const announce = createChatAnnounce(view)

  wireCollapseToggle(panel, toggle)

  // Solo se manda el texto: el emisor (slot y nombre) lo pone el servidor.
  form.addEventListener('submit', e => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    session.socket.send({ type: 'chat_send', text })
    input.value = ''
  })

  // El texto ajeno entra SIEMPRE por textContent, nunca por innerHTML.
  function append(m) {
    const line = document.createElement('div')
    line.className = 'chat-line'
    const who = document.createElement('b')
    who.style.color = m.slot === 0 ? 'var(--amber)' : OWNER_COLORS[m.slot] ?? '#94a3b8'
    who.textContent = m.name
    const said = document.createElement('span')
    said.textContent = `: ${m.text}`
    line.append(who, said)
    log.appendChild(line)
    while (log.childElementCount > MAX_LOG) log.firstElementChild.remove()
    log.scrollTop = log.scrollHeight
  }

  // El historial recibe a todos por igual. Lo que cambia es de dónde SALE la voz:
  // el usuario tiene avatar y habla desde él; el admin (slot 0) no tiene cuerpo
  // en el mundo, así que su mensaje se anuncia desde el borde de la ventana y ni
  // siquiera pasa por el mundo 3D.
  const off = session.on('chat_message', m => {
    append(m)
    if (m.slot === 0) announce.announce(m.name, m.text)
    else world.sayChat(m.slot, m.text)
  })
  return () => { off(); announce.dispose() }
}

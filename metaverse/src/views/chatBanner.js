import { chatOpacity, chatExpired } from './chatTiming.js'

// ════════════════════════════════════════════════════════════════
//  ANUNCIO DEL ADMIN — el admin no tiene avatar en el mundo: es el
//  operador de la sala. Su voz no puede salir de un cuerpo, así que
//  no es una burbuja sobre un techo (chatBubbles.js) sino un anuncio
//  pegado al borde superior de la ventana, como una megafonía. La
//  diferencia es deliberada: el chat está para ver AVATARES hablando,
//  y un mensaje sin cuerpo tiene que leerse distinto a uno con cuerpo.
//  Por eso es DOM y no un sprite: pertenece a la ventana, no al mundo.
//  Permanencia y desvanecido salen de chatTiming.js, los mismos de la
//  burbuja: en pantalla las dos son un solo sistema.
// ════════════════════════════════════════════════════════════════

// El centro del borde superior está vacío en las dos vistas: la barra reparte
// su contenido a los costados y ya no hay chip de sala disputándole el sitio.
// El anuncio cuelga de ese centro sin empujar a nadie, así que cuando el admin
// habla NADA se mueve en pantalla. Si la ventana se angosta hasta que el
// anuncio alcanzaría el panel de la izquierda, el que cede es el anuncio
// (se estrecha; ver .chat-announce en style.css): lo que no puede taparse son
// las zonas rojas del detector.
export function createChatAnnounce(view) {
  let el = null
  let rafId = null
  let born = 0

  function stop() {
    if (rafId == null) return
    cancelAnimationFrame(rafId)
    rafId = null
  }

  function frame() {
    const age = performance.now() - born
    if (chatExpired(age)) { drop(); return }
    el.style.opacity = chatOpacity(age)
    rafId = requestAnimationFrame(frame)
  }

  function drop() {
    stop()
    el?.remove()
    el = null
  }

  return {
    // Un anuncio nuevo REEMPLAZA al anterior (misma regla que la burbuja):
    // apilarlos dejaría el borde de la ventana ilegible en cuanto el admin
    // escriba rápido.
    announce(name, text) {
      stop()
      const previo = el
      el = document.createElement('div')
      el.className = 'chat-announce'
      el.setAttribute('role', 'status')      // megafonía: se anuncia, no interrumpe
      const who = document.createElement('b')
      who.textContent = `👑 ${name}`
      const said = document.createElement('span')
      said.textContent = text                // texto ajeno: SIEMPRE por textContent
      el.append(who, said)
      view.appendChild(el)
      previo?.remove()
      born = performance.now()
      rafId = requestAnimationFrame(frame)
    },

    dispose: drop,
  }
}

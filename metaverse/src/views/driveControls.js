// ════════════════════════════════════════════════════════════════
//  VOLANTE — reglas puras de los controles de conducción.
//  DOS canales distintos, y confundirlos es el error a evitar:
//
//  · ACELERADOR (↑) — SOSTENIDO. El vehículo no avanza solo: va
//    mientras el dueño mantenga la tecla. Dos mensajes por pisada
//    (drive_throttle on/off), no un flujo de 20 Hz.
//  · SALIDA DEL CRUCE (←/↓/→) — EVENTO de un solo uso, que se
//    consume en el próximo cruce (drive_intent). Sin nada pedido,
//    sigue recto igual.
//
//  NO HAY FRENO ni REVERSA, y ninguno de los dos necesita una guarda
//  que lo prohíba: frenar ES soltar ↑, y el acelerador es un booleano
//  que solo elige entre la velocidad normal y cero.
//
//  Como en invokeLocks.js, el estado no lo recuerda el cliente: la
//  visibilidad la dicta sim_info (fleets[].personal.active) y el
//  resto lo dicta drive_state. Así el volante sobrevive a recargas y
//  reconexiones, y desaparece solo cuando el vehículo deja la vía.
// ════════════════════════════════════════════════════════════════

// Las únicas intenciones que acepta el servidor (espejo de server/simulation.js).
export const DRIVE_DIRS = ['left', 'straight', 'right']

// Las flechas, y lo que hace cada una:
//  · ↑ mueve el auto (acelerador). Ya NO es "recto".
//  · ←/↓/→ son las TRES salidas del próximo cruce. ↓ es "seguir recto", y también
//    es como se cancela un giro ya pedido.
//
// ↓ = recto y no = freno, aunque la flecha apunte hacia atrás: no hay freno que
// mapear, porque frenar ES soltar ↑. Un ↓ que frenara sería una segunda forma de
// hacer lo mismo, y dejaría a "recto" sin tecla — que es como estaba y no servía.
// Marcha atrás no puede dar: el acelerador es un booleano (ver arriba).
const KEY_TURNS = { ArrowLeft: 'left', ArrowDown: 'straight', ArrowRight: 'right' }
const KEY_THROTTLE = 'ArrowUp'

// Etiquetas de los avisos efímeros (#dc-note). Cada dirección lleva su frase
// completa: "seguir recto" no se deja construir con la plantilla de los giros.
export const DRIVE_ACCEPT_NOTE = {
  left: 'Giro pedido: izquierda en el próximo cruce',
  straight: 'Pedido: seguir recto en el próximo cruce',
  right: 'Giro pedido: derecha en el próximo cruce',
}
export const DRIVE_REJECT_NOTE = {
  left: 'En el próximo cruce no se puede girar a la izquierda',
  straight: 'En el próximo cruce no se puede seguir recto',
  right: 'En el próximo cruce no se puede girar a la derecha',
}

// El volante se muestra SOLO mientras el vehículo personal está rodando. Manda
// personal.active (no personal.invoked, que sigue en true después de llegar):
// aquí el criterio es el opuesto al del botón de invocar, porque un vehículo que
// ya llegó no se conduce. El reset del admin devuelve active a false y lo oculta.
export function driveControlsVisible(fleet) {
  return !!fleet?.personal?.active
}

// Cajas de texto: el chat de la sala y los selects de origen/destino. Las flechas
// dentro de ellas son del texto (o de la lista), nunca del volante.
function isTypingTarget(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

// Qué hace una tecla del volante, o null si no es del volante o si el evento sale
// de una caja de texto. Se miran las DOS puntas: `target` (de dónde salió el
// evento) y `activeElement` (qué tiene el foco). En la práctica coinciden —el
// keydown burbujea desde el elemento enfocado—, pero basta con que una de las dos
// sea el #chat-text para que escribir "←" en un mensaje NO mueva el vehículo.
//
// Devuelve la ACCIÓN, no una dirección, porque las flechas ya no son todas lo
// mismo: { type: 'throttle' } (sostenida) | { type: 'turn', dir } (evento).
export function driveActionForKeyEvent({ key, target, activeElement } = {}) {
  if (isTypingTarget(target) || isTypingTarget(activeElement)) return null
  if (key === KEY_THROTTLE) return { type: 'throttle' }
  const dir = KEY_TURNS[key]
  return dir ? { type: 'turn', dir } : null
}

// Un giro se apaga cuando la malla no lo tiene en el próximo cruce: el jurado ve
// que es imposible ANTES de intentarlo, en vez de descubrirlo porque no pasa nada.
// Sin drive_state todavía (el vehículo acaba de salir) no se apaga ninguno: el
// servidor valida igual, y apagar por defecto bloquearía giros legítimos.
export function driveOptionDisabled(state, dir) {
  return state?.options ? !state.options[dir] : false
}

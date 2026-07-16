import { session } from '../net/session.js'
import {
  DRIVE_DIRS, DRIVE_ACCEPT_NOTE, DRIVE_REJECT_NOTE,
  driveControlsVisible, driveActionForKeyEvent, driveOptionDisabled,
} from './driveControls.js'

// ════════════════════════════════════════════════════════════════
//  PANEL DEL VOLANTE — con lo que el usuario conduce SU vehículo.
//  Se posa en el borde inferior del mapa, debajo de las vías: se
//  conduce mirando el carro, no la barra lateral.
//
//  El ACELERADOR (↑) es el control principal y es SOSTENIDO: el
//  vehículo no avanza solo. Las otras tres flechas (←/↓/→) eligen la
//  salida del próximo cruce y son eventos de un solo uso.
//  Los botones son obligatorios (nadie adivina un atajo de teclado);
//  las flechas son el atajo para quien ya sabe.
//  Las reglas puras están en driveControls.js.
// ════════════════════════════════════════════════════════════════
const NOTE_HINT = 'Mantené ↑ para avanzar · ←/↓/→ eligen por dónde salís del próximo cruce'
const NOTE_BLOCKED = 'Hay un bloqueo más adelante: conviene girar en el próximo cruce'

// Una sola fila y alto constante: el aviso de bloqueo entra al lado de los
// botones, no debajo. Un panel que crece hacia arriba acabaría pisando la fila
// de zonas rojas del borde sur del mapa justo cuando hay tráfico que mirar.
//
// El acelerador va PRIMERO y más ancho: es el único control sin el cual no pasa
// nada, y es lo primero que alguien tiene que encontrar. Después, las tres salidas
// del cruce en el orden en que están en la calle: izquierda, recto, derecha.
export const DRIVE_PANEL_HTML = `
  <div id="drive-panel" class="panel drive-panel hidden">
    <button id="drive-throttle" class="drive-btn drive-throttle" title="Mantener para avanzar (↑). Al soltar, frena.">↑ Acelerar</button>
    <button id="drive-left" class="drive-btn" title="Girar a la izquierda en el próximo cruce (←)">← Izquierda</button>
    <button id="drive-straight" class="drive-btn" title="Seguir recto en el próximo cruce (↓). También cancela un giro ya pedido.">↓ Recto</button>
    <button id="drive-right" class="drive-btn" title="Girar a la derecha en el próximo cruce (→)">Derecha →</button>
    <span id="drive-warn" class="drive-warn hidden">⚠️ Bloqueo adelante</span>
  </div>
`

// Cablea el volante: manda drive_throttle / drive_intent y pinta cada drive_state.
// `world` es para la ruta punteada, que llega en el mismo drive_state y es parte de
// conducir: se enciende y se apaga con el volante, no por su cuenta.
// `showNote` es el aviso efímero de la vista (#dc-note). Devuelve applyFleet, que la
// vista llama con SU entrada de sim_info.fleets, y dispose para el teardown.
export function wireDrivePanel(view, world, showNote) {
  const panel = view.querySelector('#drive-panel')
  const warn = view.querySelector('#drive-warn')
  const btnThrottle = view.querySelector('#drive-throttle')
  const buttons = Object.fromEntries(DRIVE_DIRS.map(d => [d, view.querySelector(`#drive-${d}`)]))

  let state = null        // último drive_state; null = el servidor todavía no lo mandó
  let visible = false     // lo dicta sim_info, no el cliente
  let throttling = false  // ¿ya le dijimos al servidor que estamos acelerando?

  function render() {
    panel.classList.toggle('hidden', !visible)
    for (const d of DRIVE_DIRS) {
      buttons[d].disabled = driveOptionDisabled(state, d)
      // 'pending' = el giro que el servidor YA aceptó para el próximo cruce.
      buttons[d].classList.toggle('pending', state?.pending === d)
    }
    btnThrottle.classList.toggle('pressed', throttling)
    warn.classList.toggle('hidden', !state?.blockedAhead)
  }

  // Acelerador. Se manda SOLO en el cambio: mantener la tecla dispara un keydown
  // repetido ~30 veces por segundo, y cada uno sería un mensaje idéntico.
  // El `?.` no es defensa por las dudas: dispose() suelta el acelerador (ver abajo)
  // y la salida de la sala hace `session.leave()` ANTES de desmontar la vista, así
  // que el socket YA es null cuando llega el `off`. Sin la guarda, salir con la
  // tecla pisada tiraba un TypeError adentro del teardown y se llevaba puesto el
  // resto: sin world.dispose(), quedaban vivos el bucle de render y el WebGL.
  // El servidor no queda esperando ese `off`: al cerrarse el socket lo suelta él.
  function setThrottle(on) {
    if (!visible && on) return
    if (on === throttling) return
    throttling = on
    session.socket?.send({ type: 'drive_throttle', on })
    render()
  }

  // El servidor toma el slot del socket e ignora en silencio un giro imposible.
  // Ese silencio no sirve de respuesta: si la malla no tiene el giro, se dice.
  function sendIntent(dir) {
    if (!visible) return
    if (driveOptionDisabled(state, dir)) { showNote(DRIVE_REJECT_NOTE[dir]); return }
    session.socket.send({ type: 'drive_intent', dir })
  }

  for (const d of DRIVE_DIRS) buttons[d].addEventListener('click', () => sendIntent(d))

  // El botón acelerador es de MANTENER, como la tecla. `pointer*` cubre mouse y
  // touch con un solo par de listeners. `pointerleave` y `pointercancel` no son
  // paranoia: soltar el botón con el dedo/mouse ya fuera de él no dispara
  // `pointerup` sobre el botón, y el auto se quedaría acelerando solo.
  btnThrottle.addEventListener('pointerdown', e => { e.preventDefault(); setThrottle(true) })
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    btnThrottle.addEventListener(ev, () => setThrottle(false))
  }

  // Las flechas escuchan en la ventana porque el volante no tiene foco propio: se
  // conduce mirando el mapa. Por eso el filtro de driveActionForKeyEvent es lo único
  // que separa "conducir" de "escribir en el chat".
  function onKeyDown(e) {
    if (!visible) return
    const act = driveActionForKeyEvent({ key: e.key, target: e.target, activeElement: document.activeElement })
    if (!act) return
    e.preventDefault()   // conduciendo, las flechas son del volante y no de la página
    if (act.type === 'throttle') { setThrottle(true); return }   // el repetido lo filtra setThrottle
    // La intención de giro es un evento, no un control sostenido: dejar correr el
    // repetido del teclado mandaría ~30 mensajes por segundo contra un piso de 50 ms.
    if (e.repeat) return
    sendIntent(act.dir)
  }
  function onKeyUp(e) {
    const act = driveActionForKeyEvent({ key: e.key, target: e.target, activeElement: document.activeElement })
    if (act?.type === 'throttle') setThrottle(false)
  }
  // Perder el foco con la tecla pisada es el agujero clásico de un control
  // sostenido: el keyup se lo lleva la otra ventana y acá no llega NUNCA, así que
  // el auto se iría solo. Al perder el foco, se suelta.
  function onBlur() { setThrottle(false) }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  // El acuse de un giro es el drive_state de vuelta, no el clic: lo que se resalta
  // y lo que se avisa es lo que el servidor aceptó.
  const off = session.on('drive_state', m => {
    const prev = state
    state = m
    if (m.pending && m.pending !== prev?.pending) showNote(DRIVE_ACCEPT_NOTE[m.pending])
    if (m.blockedAhead && !prev?.blockedAhead) showNote(NOTE_BLOCKED)
    // La ruta viva: el servidor solo reemite drive_state cuando algo cambió, así que
    // esto se redibuja justo cuando Spark pinta una zona y la ruta se desvía.
    world.showSuggestedRoute(m.route)
    render()
  })

  return {
    // sim_info: `mine` es la entrada de fleets del usuario que mira (o null si el
    // servidor todavía no conoce su flota).
    applyFleet(mine) {
      const next = driveControlsVisible(mine)
      if (next === visible) return
      visible = next
      // El vehículo dejó la vía (llegó, o el admin reinició): lo que sabíamos del
      // cruce que venía ya no vale. La próxima invocación trae su propio estado.
      if (next) showNote(NOTE_HINT)
      else {
        state = null; throttling = false
        world.showSuggestedRoute(null)   // sin vehículo no hay ruta viva que recomendar
      }
      render()
    },
    dispose() {
      off()
      world.showSuggestedRoute(null)
      // Salir de la vista con la tecla pisada dejaría el vehículo acelerando en un
      // servidor que ya no tiene quién le mande el `off`.
      setThrottle(false)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}

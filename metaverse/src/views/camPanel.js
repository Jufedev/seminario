import { CAM_MODES, CAM_FALLBACK, chaseAvailable, camModeAfterFleet } from './camControls.js'

// ════════════════════════════════════════════════════════════════
//  SELECTOR DE VISTA — dos vistas, las dos con una pregunta detrás:
//  el mapa (¿dónde está el tráfico?) y el volante (¿qué tengo
//  delante?). El conductor se enciende solo al salir el vehículo;
//  el botón está para poder volver al mapa sin bajarse.
//  Las reglas puras están en camControls.js.
// ════════════════════════════════════════════════════════════════
const CAM_LABELS = { '2d': '🗺️ Mapa', chase: '🚗 Conductor' }
const CAM_TITLES = {
  '2d': 'Vista cenital del mapa: es donde mejor se leen las zonas rojas',
  chase: 'Cámara pegada a tu vehículo (necesita tenerlo rodando)',
}
const NOTE_CHASE_OFF = 'Tu vehículo dejó la vía: volvemos al mapa'

export const CAM_PANEL_HTML = `
  <div class="cam-toggle panel" style="padding:6px">
    ${CAM_MODES.map(m => `
      <button id="btn-cam-${m}" title="${CAM_TITLES[m]}">${CAM_LABELS[m]}</button>
    `).join('')}
  </div>
`

// Cablea el selector contra el mundo ya creado. `showNote` es el aviso efímero de
// la vista (#dc-note). Devuelve applyFleet, que la vista llama con SU entrada de
// sim_info.fleets, y dispose para el teardown.
// No devuelve dispose: los botones viven dentro de `view`, que la vista
// desmonta entera, y acá no hay listeners de window ni suscripciones al socket.
export function wireCamPanel(view, world, showNote) {
  const buttons = Object.fromEntries(CAM_MODES.map(m => [m, view.querySelector(`#btn-cam-${m}`)]))
  let chaseEnabled = false   // lo dicta sim_info, no el cliente

  function render() {
    for (const m of CAM_MODES) {
      buttons[m].classList.toggle('active', world.mode === m)
    }
    // Conductor apagado cuando no hay a quién seguir: el jurado ve que el modo
    // existe y por qué no se puede usar todavía, en vez de hacer clic sin efecto.
    buttons.chase.disabled = !chaseEnabled
  }

  for (const m of CAM_MODES) {
    buttons[m].addEventListener('click', () => { world.setMode(m); render() })
  }
  render()

  return {
    // sim_info: `mine` es la entrada de fleets del usuario que mira (o null si el
    // servidor todavía no conoce su flota).
    applyFleet(mine) {
      // `wasAvailable` es el estado ANTERIOR: la regla mira la transición, para
      // que subirse sea automático una sola vez y el usuario pueda volver al mapa.
      const next = camModeAfterFleet({ mode: world.mode, wasAvailable: chaseEnabled, fleet: mine })
      chaseEnabled = chaseAvailable(mine)
      if (next !== world.mode) {
        world.setMode(next)
        // Solo se avisa la caída: subirse al conductor se explica solo (la vista
        // cambia a tu auto justo cuando lo invocaste), pero perderlo no.
        if (next === CAM_FALLBACK) showNote(NOTE_CHASE_OFF)
      }
      render()
    },
  }
}

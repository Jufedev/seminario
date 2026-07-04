// ════════════════════════════════════════════════════════════════
//  ROUTER — cambia entre las 3 vistas usando el hash de la URL
// ════════════════════════════════════════════════════════════════
import { renderPortada } from './views/portada.js'
import { renderConfig } from './views/config.js'
import { renderSimulacion } from './views/simulacion.js'

const ROUTES = {
  '#/': renderPortada,
  '#/config': renderConfig,
  '#/simulacion': renderSimulacion,
}

export function navigate(hash) {
  location.hash = hash
}

function renderCurrent() {
  // Si la vista anterior dejó un limpiador (ej. detener el loop de Three.js), se ejecuta
  if (window.__teardownView) { window.__teardownView(); window.__teardownView = null }
  const view = ROUTES[location.hash] || renderPortada
  const app = document.getElementById('app')
  app.innerHTML = ''
  view(app)
}

export function initRouter() {
  window.addEventListener('hashchange', renderCurrent)
  if (!location.hash) location.hash = '#/'
  renderCurrent()
}

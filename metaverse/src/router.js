// ════════════════════════════════════════════════════════════════
//  ROUTER — cambia entre las 3 vistas usando el hash de la URL
// ════════════════════════════════════════════════════════════════
import { renderPortada } from './views/portada.js'
import { renderLobby } from './views/lobby.js'
import { renderAdminView } from './views/adminView.js'
import { renderUserView } from './views/userView.js'

const ROUTES = {
  '#/': renderPortada,
  // Multi-usuario (M2): lobby primero; según el rol, admin (3D) o usuario (2D)
  '#/lobby': renderLobby,
  '#/admin': renderAdminView,
  '#/user': renderUserView,
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

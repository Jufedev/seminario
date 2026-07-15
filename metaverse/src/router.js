// ════════════════════════════════════════════════════════════════
//  ROUTER — cambia entre las 3 vistas usando la ruta de la URL
//  Rutas limpias (/lobby, /admin) en vez de hash (#/lobby): la URL que
//  el admin comparte no lleva '#'. Exige que el servidor devuelva
//  index.html en cualquier ruta (nginx: try_files … /index.html; el
//  servidor de desarrollo de Vite ya lo hace).
// ════════════════════════════════════════════════════════════════
import { renderPortada } from './views/portada.js'
import { renderLobby } from './views/lobby.js'
import { renderAdminView } from './views/adminView.js'
import { renderUserView } from './views/userView.js'

const ROUTES = {
  '/': renderPortada,
  // Multi-usuario (M2): lobby primero; según el rol, admin (3D) o usuario (2D)
  '/lobby': renderLobby,
  '/admin': renderAdminView,
  '/user': renderUserView,
}

// Ruta → vista. Una ruta desconocida (enlace viejo con '#', typo) cae en la
// portada en vez de dejar la pantalla en blanco.
export function resolveRoute(pathname) {
  return ROUTES[pathname] ?? renderPortada
}

export function navigate(path) {
  // Misma ruta: ni se apila una entrada repetida en el historial ni se repinta.
  if (path === location.pathname) return
  history.pushState(null, '', path)
  renderCurrent()
}

function renderCurrent() {
  // Si la vista anterior dejó un limpiador (ej. detener el loop de Three.js), se ejecuta
  if (window.__teardownView) { window.__teardownView(); window.__teardownView = null }
  const view = resolveRoute(location.pathname)
  const app = document.getElementById('app')
  app.innerHTML = ''
  view(app)
}

export function initRouter() {
  // popstate cubre el botón "atrás" del navegador: repinta pasando por el mismo
  // renderCurrent, así que la vista que se abandona SIEMPRE ejecuta su limpiador
  // (sin él, cada navegación dejaría vivo un loop de Three.js).
  window.addEventListener('popstate', renderCurrent)
  renderCurrent()
}

// Tests del router (bun test — sin navegador).
// El router pasó de hash (#/lobby) a rutas limpias (/lobby): lo que se blinda
// aquí es la tabla de rutas, que es lógica pura. El resto del router (pushState,
// popstate, el limpiador de la vista) toca el DOM y se prueba en el navegador.
import { describe, expect, test } from 'bun:test'
import { resolveRoute } from '../src/router.js'
import { renderPortada } from '../src/views/portada.js'
import { renderLobby } from '../src/views/lobby.js'
import { renderAdminView } from '../src/views/adminView.js'
import { renderUserView } from '../src/views/userView.js'

describe('tabla de rutas (resolveRoute)', () => {
  test('cada ruta limpia lleva a su vista', () => {
    expect(resolveRoute('/')).toBe(renderPortada)
    expect(resolveRoute('/lobby')).toBe(renderLobby)
    expect(resolveRoute('/admin')).toBe(renderAdminView)
    expect(resolveRoute('/user')).toBe(renderUserView)
  })

  // Una ruta desconocida no puede dejar la pantalla en blanco.
  test('lo desconocido cae en la portada', () => {
    for (const path of ['/noexiste', '/admin/', '/ADMIN', '', '/lobby?x=1']) {
      expect(resolveRoute(path)).toBe(renderPortada)
    }
  })

  // Un enlace viejo con hash ya no es una ruta: el pathname de '#/lobby' es '/'.
  // Que la tabla no lo reconozca es lo correcto; lo atiende la portada.
  test('las rutas viejas con hash ya no resuelven a su vista', () => {
    expect(resolveRoute('#/lobby')).toBe(renderPortada)
    expect(resolveRoute('#/admin')).toBe(renderPortada)
  })

  // El router llama resolveRoute con location.pathname, que nunca es nulo, pero
  // la tabla no puede reventar si le llega algo raro.
  test('no revienta con valores ausentes', () => {
    expect(resolveRoute(undefined)).toBe(renderPortada)
    expect(resolveRoute(null)).toBe(renderPortada)
  })
})

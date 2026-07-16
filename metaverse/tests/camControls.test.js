// Tests de las reglas puras del selector de vista (bun test — sin navegador).
// La cámara conductor sigue al vehículo personal, así que su única regla dura es
// QUÉ pasa cuando ese vehículo deja de existir. Falla en silencio de la peor
// forma: la cámara se queda mirando una calle vacía y el usuario no tiene cómo
// saber que lo que ve ya no es su auto.
// Se blinda además el contrato con el servidor: sim_info trae personal.active, el
// mismo campo del que cuelga el volante — si el servidor lo renombra, el modo
// conductor queda inalcanzable y ningún test de la vista lo notaría.
import { describe, expect, test } from 'bun:test'
import { CAM_MODES, CAM_FALLBACK, chaseAvailable, camModeAfterFleet } from '../src/views/camControls.js'
import { Simulation } from '../server/simulation.js'

// La simulación hace console.debug de sus eventos; se silencia igual que en
// server/index.js.
console.debug = () => {}

// Entradas de sim_info.fleets a mano, para las reglas puras.
const fleet = (over = {}) => ({
  origin: 'P1', dest: 'P2', invoked: false,
  personal: { invoked: false, active: false, arrived: 0 },
  ...over,
})
const personal = (p) => fleet({ personal: { invoked: false, active: false, arrived: 0, ...p } })

describe('chaseAvailable (cuándo hay a quién seguir)', () => {
  test('sin flota conocida todavía → no', () => {
    expect(chaseAvailable(null)).toBe(false)
    expect(chaseAvailable(undefined)).toBe(false)
  })

  test('sin invocar el vehículo personal → no', () => {
    expect(chaseAvailable(fleet())).toBe(false)
  })

  test('vehículo en camino → sí', () => {
    expect(chaseAvailable(personal({ invoked: true, active: true }))).toBe(true)
  })

  // Mismo criterio que el volante: manda `active`, no `invoked`. A un vehículo
  // que ya llegó no se lo conduce y tampoco se lo sigue.
  test('vehículo ya llegado → no, aunque siga invocado', () => {
    expect(chaseAvailable(personal({ invoked: true, active: false, arrived: 1 }))).toBe(false)
  })

  test('la flota rodando no habilita el conductor: solo el vehículo personal', () => {
    expect(chaseAvailable(fleet({ invoked: true }))).toBe(false)
  })
})

describe('camModeAfterFleet (subirse solo, bajarse solo, y nada más)', () => {
  const rodando = personal({ invoked: true, active: true })
  const llegado = personal({ invoked: true, active: false, arrived: 1 })
  const modo = (mode, wasAvailable, fleet) => camModeAfterFleet({ mode, wasAvailable, fleet })

  // El vehículo acaba de salir: invocarlo y además buscar el botón de la cámara
  // son dos pasos para una sola intención.
  test('el vehículo sale a la vía → se sube solo al conductor', () => {
    expect(modo('2d', false, rodando)).toBe('chase')
  })

  // LA REGLA QUE HACE ÚTIL EL BOTÓN: el usuario se volvió al mapa con el vehículo
  // rodando. Los sim_info siguen llegando con active=true, y NINGUNO puede
  // devolverlo al conductor — si esto mirara el estado y no la transición, el
  // botón 2D no serviría para nada mientras maneja.
  test('ya arriba y en el mapa por elección → los sim_info NO lo devuelven al conductor', () => {
    expect(modo('2d', true, rodando)).toBe('2d')
  })

  test('siguiendo un vehículo que rueda → se sigue en conductor', () => {
    expect(modo('chase', true, rodando)).toBe('chase')
  })

  test('el vehículo llega mientras se lo sigue → cae al mapa', () => {
    expect(modo('chase', true, llegado)).toBe(CAM_FALLBACK)
  })

  test('el admin reinicia la sala (sin flota) → cae al mapa', () => {
    expect(modo('chase', true, null)).toBe(CAM_FALLBACK)
  })

  // Sin vehículo y ya en el mapa: no hay nada que hacer.
  test('sin vehículo y en el mapa → se queda en el mapa', () => {
    expect(modo('2d', false, null)).toBe('2d')
  })

  // Invocar → llegar → volver a invocar tiene que volver a subir la cámara.
  test('un segundo vehículo tras llegar el primero → se sube solo otra vez', () => {
    expect(modo('2d', false, rodando)).toBe('chase')
  })
})

describe('CAM_MODES (lo que ofrece el panel del usuario)', () => {
  // El '3d' de órbita libre existe en onlineWorld y es del ADMIN: el usuario tiene
  // dos vistas con una pregunta detrás (el mapa y el volante), y una órbita libre
  // en el medio no contesta ninguna suya.
  test('el usuario elige entre mapa y conductor, y nada más', () => {
    expect(CAM_MODES).toEqual(['2d', 'chase'])
  })

  test('la vista de reserva es uno de los modos', () => {
    expect(CAM_MODES).toContain(CAM_FALLBACK)
  })
})

// El modo conductor cuelga de personal.active, igual que el volante. Las reglas
// de arriba son ciertas sobre objetos a mano; esto fija que el servidor mande de
// verdad ese campo, que es de donde salen.
describe('contrato con el servidor (sim_info.fleets[].personal)', () => {
  const mine = (sim, slot) => sim.simInfo().fleets.find(f => f.slot === slot)

  // El recorrido real: invocar el vehículo sube la cámara sola.
  test('un vehículo personal invocado se reporta active → la cámara se sube sola', () => {
    const sim = new Simulation('ECCI-CAM1', 'e0')
    sim.setUserRoute(1, 'T1', 'T3')
    expect(chaseAvailable(mine(sim, 1))).toBe(false)
    sim.invokePersonal(1)
    expect(mine(sim, 1).personal.active).toBe(true)
    expect(chaseAvailable(mine(sim, 1))).toBe(true)
    expect(camModeAfterFleet({ mode: '2d', wasAvailable: false, fleet: mine(sim, 1) })).toBe('chase')
  })

  test('sin invocar nada, el conductor queda deshabilitado', () => {
    const sim = new Simulation('ECCI-CAM2', 'e0')
    sim.setUserRoute(1, 'T1', 'T3')
    expect(chaseAvailable(mine(sim, 1))).toBe(false)
  })

  // El reset del admin apaga personal.active: la cámara tiene que soltar el auto.
  test('el reset del admin devuelve la cámara al mapa', () => {
    const sim = new Simulation('ECCI-CAM3', 'e0')
    sim.setUserRoute(1, 'T1', 'T3')
    sim.invokePersonal(1)
    expect(chaseAvailable(mine(sim, 1))).toBe(true)
    sim.control('reset')
    expect(mine(sim, 1).personal.active).toBe(false)
    expect(camModeAfterFleet({ mode: 'chase', wasAvailable: true, fleet: mine(sim, 1) })).toBe(CAM_FALLBACK)
  })
})

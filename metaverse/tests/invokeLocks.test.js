// Tests de los bloqueos de invocación (bun test — sin Kafka ni navegador).
// Todo se invoca UNA vez por corrida (retro del jurado): la flota, el vehículo
// personal y los puntos de origen/destino con los que se invocaron. Solo los
// reabre el reset del admin. Se blinda la cadena completa, porque el bloqueo se
// rompe en silencio si se corta en cualquier eslabón:
//  · las reglas puras que apagan los controles,
//  · el contrato del servidor: sim_info trae fleets[].invoked y
//    fleets[].personal.invoked,
//  · el reset del admin devuelve los dos a false (es la ÚNICA señal que reabre).
import { describe, expect, test } from 'bun:test'
import {
  fleetButtonDisabled, personalButtonDisabled, personalButtonLabel, routeSelectsDisabled,
} from '../src/views/invokeLocks.js'
import { Simulation } from '../server/simulation.js'

// La simulación hace console.debug de sus eventos; se silencia igual que en
// server/index.js.
console.debug = () => {}

const mine = (sim, slot) => sim.simInfo().fleets.find(f => f.slot === slot)

// Entradas de sim_info.fleets a mano, para las reglas puras.
const fleet = (over = {}) => ({
  origin: 'P1', dest: 'P2', invoked: false,
  personal: { invoked: false, active: false, arrived: 0 },
  ...over,
})
const personal = (p) => fleet({ personal: { invoked: false, active: false, arrived: 0, ...p } })

describe('fleetButtonDisabled (regla pura del botón)', () => {
  test('sin flota conocida todavía → bloqueado', () => {
    expect(fleetButtonDisabled(null)).toBe(true)
    expect(fleetButtonDisabled(undefined)).toBe(true)
  })

  test('con ruta incompleta → bloqueado', () => {
    expect(fleetButtonDisabled({ origin: 'P1', dest: null, invoked: false })).toBe(true)
    expect(fleetButtonDisabled({ origin: null, dest: 'P2', invoked: false })).toBe(true)
  })

  test('con ruta completa y sin invocar → habilitado', () => {
    expect(fleetButtonDisabled({ origin: 'P1', dest: 'P2', invoked: false })).toBe(false)
  })

  // El caso de la retro: invocada la flota, el botón NO vuelve solo.
  test('ya invocada → bloqueado aunque la ruta esté completa', () => {
    expect(fleetButtonDisabled({ origin: 'P1', dest: 'P2', invoked: true })).toBe(true)
  })
})

describe('personalButtonDisabled (regla pura del botón)', () => {
  test('sin flota conocida todavía → bloqueado', () => {
    expect(personalButtonDisabled(null)).toBe(true)
    expect(personalButtonDisabled(undefined)).toBe(true)
  })

  test('con ruta incompleta → bloqueado', () => {
    expect(personalButtonDisabled(fleet({ dest: null }))).toBe(true)
    expect(personalButtonDisabled(fleet({ origin: null }))).toBe(true)
  })

  test('con ruta completa y sin invocar → habilitado', () => {
    expect(personalButtonDisabled(fleet())).toBe(false)
  })

  test('vehículo en camino → bloqueado', () => {
    expect(personalButtonDisabled(personal({ invoked: true, active: true }))).toBe(true)
  })

  // El caso de la retro (ítem 3): al LLEGAR, active vuelve a false. Antes eso
  // reabría el botón y dejaba invocar un segundo vehículo en la misma corrida.
  test('vehículo ya llegado → sigue bloqueado (manda invoked, no active)', () => {
    expect(personalButtonDisabled(personal({ invoked: true, active: false, arrived: 1 }))).toBe(true)
  })
})

describe('personalButtonLabel (el rótulo no miente sobre el vehículo)', () => {
  test('sin invocar → invita a invocar', () => {
    expect(personalButtonLabel(null)).toBe('🚗 Invocar MI vehículo')
    expect(personalButtonLabel(fleet())).toBe('🚗 Invocar MI vehículo')
  })

  test('en camino → lo dice', () => {
    expect(personalButtonLabel(personal({ invoked: true, active: true }))).toBe('🚗 Mi vehículo va en camino')
  })

  // Bloqueado, pero ya no va en camino: el rótulo no puede seguir diciéndolo.
  test('ya llegado → deja de decir que va en camino', () => {
    expect(personalButtonLabel(personal({ invoked: true, active: false, arrived: 1 })))
      .toBe('🚗 Mi vehículo ya llegó')
  })
})

describe('routeSelectsDisabled (regla pura de los puntos)', () => {
  test('sin flota conocida todavía → libres', () => {
    expect(routeSelectsDisabled(null)).toBe(false)
    expect(routeSelectsDisabled(undefined)).toBe(false)
  })

  test('sin invocar nada → libres', () => {
    expect(routeSelectsDisabled(fleet())).toBe(false)
    expect(routeSelectsDisabled(fleet({ origin: null, dest: null }))).toBe(false)
  })

  // Cualquiera de las dos invocaciones congela los puntos (retro, ítem 5).
  test('flota invocada → congelados', () => {
    expect(routeSelectsDisabled(fleet({ invoked: true }))).toBe(true)
  })

  test('vehículo personal invocado → congelados', () => {
    expect(routeSelectsDisabled(personal({ invoked: true, active: true }))).toBe(true)
  })

  // Al llegar el personal, active vuelve a false: los puntos NO se descongelan.
  test('vehículo personal ya llegado → siguen congelados', () => {
    expect(routeSelectsDisabled(personal({ invoked: true, active: false, arrived: 1 }))).toBe(true)
  })
})

describe('sim_info (las señales que abren y cierran los controles)', () => {
  // Dos puntos reales del mapa; la ruta es lo que crea la flota del usuario.
  const withRoute = () => {
    const sim = new Simulation('ECCI-0001', 'e0')
    expect(sim.setUserRoute(1, 'T1', 'T3')).toBe(true)
    return sim
  }

  test('la flota nace sin invocar → el botón arranca habilitado', () => {
    const sim = withRoute()
    expect(mine(sim, 1).invoked).toBe(false)
    expect(fleetButtonDisabled(mine(sim, 1))).toBe(false)
  })

  test('invokeFleet marca invoked → el botón se bloquea', () => {
    const sim = withRoute()
    expect(sim.invokeFleet(1)).toBe(true)
    expect(mine(sim, 1).invoked).toBe(true)
    expect(fleetButtonDisabled(mine(sim, 1))).toBe(true)
  })

  test('los puntos nacen libres y se congelan al invocar la flota', () => {
    const sim = withRoute()
    expect(routeSelectsDisabled(mine(sim, 1))).toBe(false)
    sim.invokeFleet(1)
    expect(routeSelectsDisabled(mine(sim, 1))).toBe(true)
  })

  test('invokePersonal marca personal.invoked → botón y puntos se bloquean', () => {
    const sim = withRoute()
    expect(personalButtonDisabled(mine(sim, 1))).toBe(false)
    expect(sim.invokePersonal(1)).toBe(true)
    expect(mine(sim, 1).personal.invoked).toBe(true)
    expect(personalButtonDisabled(mine(sim, 1))).toBe(true)
    expect(routeSelectsDisabled(mine(sim, 1))).toBe(true)
  })

  // Es la única señal de desbloqueo: si el reset dejara de limpiar invoked, los
  // controles quedarían muertos el resto de la sesión y nadie lo notaría.
  test('el reset del admin devuelve invoked a false → el botón de flota vuelve', () => {
    const sim = withRoute()
    sim.invokeFleet(1)
    expect(sim.control('reset')).toBe(true)
    expect(mine(sim, 1).invoked).toBe(false)
    expect(fleetButtonDisabled(mine(sim, 1))).toBe(false)
  })

  test('el reset del admin reabre el botón personal y descongela los puntos', () => {
    const sim = withRoute()
    sim.invokePersonal(1)
    expect(sim.control('reset')).toBe(true)
    expect(mine(sim, 1).personal.invoked).toBe(false)
    expect(personalButtonDisabled(mine(sim, 1))).toBe(false)
    expect(routeSelectsDisabled(mine(sim, 1))).toBe(false)
  })

  // Pausar NO es reiniciar: todo sigue bloqueado.
  test('pausar la sala no reabre el botón de flota', () => {
    const sim = withRoute()
    sim.invokeFleet(1)
    sim.control('pause')
    expect(fleetButtonDisabled(mine(sim, 1))).toBe(true)
  })

  test('pausar la sala no reabre el botón personal ni los puntos', () => {
    const sim = withRoute()
    sim.invokePersonal(1)
    sim.control('pause')
    expect(personalButtonDisabled(mine(sim, 1))).toBe(true)
    expect(routeSelectsDisabled(mine(sim, 1))).toBe(true)
  })
})

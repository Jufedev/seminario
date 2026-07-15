// Tests del bloqueo de "Invocar flota" (bun test — sin Kafka ni navegador).
// La flota se invoca UNA vez por corrida (retro del jurado): el botón se apaga
// al invocar y solo lo reabre el reset del admin. Se blinda la cadena completa,
// porque el bloqueo se rompe en silencio si se corta en cualquier eslabón:
//  · la regla pura que apaga el botón,
//  · el contrato del servidor: sim_info trae fleets[].invoked,
//  · el reset del admin devuelve invoked a false (es la ÚNICA señal que lo reabre).
import { describe, expect, test } from 'bun:test'
import { fleetButtonDisabled } from '../src/views/fleetButton.js'
import { Simulation } from '../server/simulation.js'

// La simulación hace console.debug de sus eventos; se silencia igual que en
// server/index.js.
console.debug = () => {}

const mine = (sim, slot) => sim.simInfo().fleets.find(f => f.slot === slot)

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

describe('sim_info.invoked (la señal que abre y cierra el botón)', () => {
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

  // Es la única señal de desbloqueo: si el reset dejara de limpiar invoked, el
  // botón quedaría muerto para el resto de la sesión y nadie lo notaría.
  test('el reset del admin devuelve invoked a false → el botón vuelve', () => {
    const sim = withRoute()
    sim.invokeFleet(1)
    expect(sim.control('reset')).toBe(true)
    expect(mine(sim, 1).invoked).toBe(false)
    expect(fleetButtonDisabled(mine(sim, 1))).toBe(false)
  })

  // Pausar NO es reiniciar: el botón sigue bloqueado.
  test('pausar la sala no reabre el botón', () => {
    const sim = withRoute()
    sim.invokeFleet(1)
    sim.control('pause')
    expect(fleetButtonDisabled(mine(sim, 1))).toBe(true)
  })
})

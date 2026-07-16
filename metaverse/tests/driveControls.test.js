// Tests de las reglas puras del volante (bun test — sin navegador).
// El volante es la única parte de la vista que compite con otro control por el
// mismo teclado, y las tres reglas que lo sostienen fallan en silencio:
//  · cuándo se ve: si dependiera de personal.invoked (como el botón de invocar)
//    el volante quedaría en pantalla después de que el vehículo llega, pidiendo
//    giros a un carro que ya no rueda,
//  · qué tecla es del volante: escribir "←" en el chat NO puede mover el carro,
//    y eso solo se nota en una demo, con alguien escribiendo,
//  · qué giro se apaga: un giro imposible tiene que verse imposible ANTES de
//    intentarlo — el servidor lo ignora en silencio, así que si el apagado se
//    rompe el síntoma es "el botón no hace nada".
// Se blinda además el contrato del servidor: sim_info trae personal.active, y
// drive_state trae options con los giros que la malla tiene de verdad.
import { describe, expect, test } from 'bun:test'
import {
  DRIVE_DIRS, DRIVE_ACCEPT_NOTE, DRIVE_REJECT_NOTE,
  driveControlsVisible, driveActionForKeyEvent, driveOptionDisabled,
} from '../src/views/driveControls.js'
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

// Elementos del DOM a mano: las reglas solo miran tagName / isContentEditable.
const el = (tagName, over = {}) => ({ tagName, ...over })
const BODY = el('BODY')

describe('driveControlsVisible (cuándo se ve el volante)', () => {
  test('sin flota conocida todavía → oculto', () => {
    expect(driveControlsVisible(null)).toBe(false)
    expect(driveControlsVisible(undefined)).toBe(false)
  })

  test('sin invocar el vehículo personal → oculto', () => {
    expect(driveControlsVisible(fleet())).toBe(false)
  })

  test('vehículo en camino → visible', () => {
    expect(driveControlsVisible(personal({ invoked: true, active: true }))).toBe(true)
  })

  // El criterio es el OPUESTO al del botón de invocar (que mira invoked): un
  // vehículo que ya llegó sigue invocado, pero no se conduce.
  test('vehículo ya llegado → oculto, aunque siga invocado', () => {
    expect(driveControlsVisible(personal({ invoked: true, active: false, arrived: 1 }))).toBe(false)
  })

  test('la flota rodando no abre el volante: solo lo abre el vehículo personal', () => {
    expect(driveControlsVisible(fleet({ invoked: true }))).toBe(false)
  })
})

describe('driveActionForKeyEvent (las flechas, y el chat que no se toca)', () => {
  const key = (k, target = BODY) => driveActionForKeyEvent({ key: k, target, activeElement: target })

  // ↑ MUEVE el auto: es el acelerador, no una intención de "seguir recto". El
  // vehículo no avanza solo, así que esta es la tecla sin la cual no pasa nada.
  test('↑ es el acelerador', () => {
    expect(key('ArrowUp')).toEqual({ type: 'throttle' })
  })

  // Las otras TRES flechas son las tres salidas del cruce. ↓ es "recto" y no un
  // freno: frenar es soltar ↑, así que un ↓ que frenara sería una segunda forma de
  // hacer lo mismo y dejaría a "recto" sin tecla.
  test('←/↓/→ son las tres salidas del próximo cruce', () => {
    expect(key('ArrowLeft')).toEqual({ type: 'turn', dir: 'left' })
    expect(key('ArrowDown')).toEqual({ type: 'turn', dir: 'straight' })
    expect(key('ArrowRight')).toEqual({ type: 'turn', dir: 'right' })
  })

  // Las cuatro flechas cubren el volante entero y NINGUNA da marcha atrás: ↓ no
  // es un freno ni una reversa, y no hay una quinta tecla que pudiera serlo.
  test('ninguna flecha da reversa: las cuatro son acelerar o salir del cruce', () => {
    for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) {
      const a = key(k)
      expect(a).not.toBeNull()
      expect(['throttle', 'turn']).toContain(a.type)
    }
  })

  // Las tres direcciones que acepta el servidor tienen las tres su tecla: si
  // alguna se quedara sin flecha, solo se podría pedir con el mouse.
  test('las tres direcciones del contrato tienen tecla', () => {
    const conTecla = ['ArrowLeft', 'ArrowDown', 'ArrowRight'].map(k => key(k).dir)
    expect(conTecla.sort()).toEqual([...DRIVE_DIRS].sort())
  })

  test('cualquier otra tecla no es del volante', () => {
    for (const k of ['a', 'Enter', ' ', 'Escape', 'w', 'ArrowUpLeft']) expect(key(k)).toBeNull()
  })

  test('sin evento → null (no revienta)', () => {
    expect(driveActionForKeyEvent()).toBeNull()
    expect(driveActionForKeyEvent({})).toBeNull()
  })

  // LA restricción: el chat de la sala tiene caja de texto y comparte el teclado
  // con el volante. Escribir un mensaje no puede mover el vehículo.
  test('escribiendo en el chat: la flecha NO conduce', () => {
    const chat = el('INPUT')
    expect(driveActionForKeyEvent({ key: 'ArrowLeft', target: chat, activeElement: chat })).toBeNull()
  })

  // El acelerador es sostenido, así que colarse en el chat sería peor que un giro:
  // el auto arrancaría y no habría keyup del volante que lo pare.
  test('escribiendo en el chat: ↑ NO acelera', () => {
    const chat = el('INPUT')
    expect(driveActionForKeyEvent({ key: 'ArrowUp', target: chat, activeElement: chat })).toBeNull()
  })

  test('también se bloquea desde textarea, select y contenido editable', () => {
    for (const box of [el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true })]) {
      expect(driveActionForKeyEvent({ key: 'ArrowLeft', target: box, activeElement: box })).toBeNull()
      expect(driveActionForKeyEvent({ key: 'ArrowUp', target: box, activeElement: box })).toBeNull()
    }
  })

  // Se miran las dos puntas: basta con que UNA sea caja de texto para no conducir.
  test('basta con que la caja tenga el foco, aunque el evento venga de otro lado', () => {
    expect(driveActionForKeyEvent({ key: 'ArrowLeft', target: BODY, activeElement: el('INPUT') })).toBeNull()
  })

  test('basta con que el evento salga de la caja, aunque el foco esté en otro lado', () => {
    expect(driveActionForKeyEvent({ key: 'ArrowLeft', target: el('INPUT'), activeElement: BODY })).toBeNull()
  })

  // Los botones del volante SÍ dejan conducir: quedan con el foco tras un clic, y
  // si eso bloqueara la flecha, usar el botón mataría el teclado.
  test('con un botón enfocado (tras un clic) las flechas siguen conduciendo', () => {
    const btn = el('BUTTON')
    expect(driveActionForKeyEvent({ key: 'ArrowLeft', target: btn, activeElement: btn })).toEqual({ type: 'turn', dir: 'left' })
    expect(driveActionForKeyEvent({ key: 'ArrowUp', target: btn, activeElement: btn })).toEqual({ type: 'throttle' })
  })
})

describe('driveOptionDisabled (el giro imposible se ve imposible)', () => {
  const state = (options) => ({ options, pending: null, blockedAhead: false })

  test('un giro que la malla no tiene → apagado', () => {
    const s = state({ left: false, straight: true, right: true })
    expect(driveOptionDisabled(s, 'left')).toBe(true)
    expect(driveOptionDisabled(s, 'straight')).toBe(false)
    expect(driveOptionDisabled(s, 'right')).toBe(false)
  })

  // Recién invocado el vehículo, el volante se ve antes del primer drive_state.
  // Apagar por defecto bloquearía giros legítimos; el servidor valida igual.
  test('sin drive_state todavía → ninguno apagado', () => {
    for (const d of DRIVE_DIRS) {
      expect(driveOptionDisabled(null, d)).toBe(false)
      expect(driveOptionDisabled({ pending: null }, d)).toBe(false)
    }
  })
})

describe('avisos del volante (uno por dirección, con su frase)', () => {
  // "seguir recto" no se construye con la plantilla de los giros: si estas frases
  // se armaran solas, el aviso diría "girar a la recto".
  test('las tres direcciones tienen aviso de aceptado y de rechazado', () => {
    for (const d of DRIVE_DIRS) {
      expect(DRIVE_ACCEPT_NOTE[d]).toBeString()
      expect(DRIVE_REJECT_NOTE[d]).toBeString()
    }
  })

  test('el aviso de recto no habla de girar', () => {
    expect(DRIVE_REJECT_NOTE.straight).not.toContain('girar')
    expect(DRIVE_ACCEPT_NOTE.straight).not.toContain('Giro')
  })
})

describe('sim_info y drive_state (las señales que el volante obedece)', () => {
  const withRoute = () => {
    const sim = new Simulation('ECCI-0002', 'e0')
    expect(sim.setUserRoute(1, 'T1', 'T3')).toBe(true)
    return sim
  }

  test('el volante nace oculto y lo abre invokePersonal', () => {
    const sim = withRoute()
    expect(driveControlsVisible(mine(sim, 1))).toBe(false)
    expect(sim.invokePersonal(1)).toBe(true)
    expect(driveControlsVisible(mine(sim, 1))).toBe(true)
  })

  test('el reset del admin cierra el volante', () => {
    const sim = withRoute()
    sim.invokePersonal(1)
    expect(sim.control('reset')).toBe(true)
    expect(driveControlsVisible(mine(sim, 1))).toBe(false)
  })

  // Pausar NO es reiniciar: el vehículo sigue en la vía y el volante se queda.
  test('pausar la sala no cierra el volante', () => {
    const sim = withRoute()
    sim.invokePersonal(1)
    sim.control('pause')
    expect(driveControlsVisible(mine(sim, 1))).toBe(true)
  })

  // El apagado de los botones cuelga de options: si el servidor dejara de mandarlo
  // (o cambiara las claves), driveOptionDisabled devolvería false para todo y el
  // giro imposible volvería a "descubrirse fallando".
  test('drive_state trae las tres opciones, y el volante las lee', () => {
    const sim = withRoute()
    sim.invokePersonal(1)
    sim.step(0.05)
    const out = sim.drainOutbox().find(o => o.msg.type === 'drive_state')
    expect(out).toBeDefined()
    expect(Object.keys(out.msg.options).sort()).toEqual([...DRIVE_DIRS].sort())
    for (const d of DRIVE_DIRS) {
      expect(driveOptionDisabled(out.msg, d)).toBe(out.msg.options[d] === false)
    }
  })
})

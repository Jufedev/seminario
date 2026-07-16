// Tests de la conducción libre (bun test — sin Kafka ni navegador).
// La enciende el vehículo personal (server/simulation.js); las flotas siguen con
// freeDrive en 0. Estos tests blindan las propiedades que, si se rompen, lo hacen
// en silencio. Del sustrato:
//  · la matemática de direcciones: es entero/string puro, y de ella cuelga TODO
//    (giro en U prohibido, bordes del mapa, giros ilegales),
//  · la caché de rutas: un avatar en conducción libre hace push() sobre su ruta, y
//    si recibiera el array de _routeCache lo corrompería para todo avatar futuro
//    con ese mismo O/D — el síntoma serían carros de flota conduciendo sinsentido,
//  · la invariante de ≥2 tramos por delante: es lo único que impide que _stepAgent
//    llegue a su rama terminal y deje de obedecer semáforos.
// Y del cableado en el servidor, que es donde se juega el volante del usuario:
//  · onRerouteIntercept: si dejara de interceptar, _triggerReroute pisaría la ruta
//    del vehículo con un Dijkstra nuevo y el volante moriría SIN error — el carro
//    quedaría en otra calle y nadie lo notaría hasta la demo.
import { describe, expect, test } from 'bun:test'
import { AgentSystem, AGENT_STATE } from '../src/sim/agents.js'
import { Simulation } from '../server/simulation.js'
import { GRAPH, NODES, setEdgeBlocked, dijkstra } from '../src/graph/mapData.js'

// El motor hace console.debug de sus eventos; se silencia igual que en server/index.js.
console.debug = () => {}

const fakeScene = { add() {}, remove() {} }          // los tests no dibujan: solo estado
const fakeTraffic = { isGreenForAxis: () => true }   // semáforos en verde: no es lo que se mide acá
const newSystem = () => new AgentSystem(fakeScene, { traffic: fakeTraffic, maxAgents: 4 })

// Todas las aristas dirigidas de la malla, como (a → b). El grafo es no dirigido,
// así que cada arista aparece en los dos sentidos.
const directedEdges = () => {
  const out = []
  for (const aId in GRAPH) for (const e of GRAPH[aId]) out.push([aId, e.to])
  return out
}

describe('_neighborInDirection (matemática de direcciones sobre la malla real)', () => {
  const sys = newSystem()
  const dir = (a, b, d) => sys._neighborInDirection(a, b, d)

  // ci+1 = este, ri+1 = norte. Con ci como eje x y ri como eje y el plano es el
  // estándar matemático: +90° (antihorario) = izquierda, -90° = derecha.
  test('rumbo ESTE: recto sigue al este, izquierda al norte, derecha al sur', () => {
    expect(dir('5_5', '6_5', 'straight')).toBe('7_5')
    expect(dir('5_5', '6_5', 'left')).toBe('6_6')
    expect(dir('5_5', '6_5', 'right')).toBe('6_4')
  })

  test('rumbo OESTE: recto sigue al oeste, izquierda al sur, derecha al norte', () => {
    expect(dir('5_5', '4_5', 'straight')).toBe('3_5')
    expect(dir('5_5', '4_5', 'left')).toBe('4_4')
    expect(dir('5_5', '4_5', 'right')).toBe('4_6')
  })

  test('rumbo NORTE: recto sigue al norte, izquierda al oeste, derecha al este', () => {
    expect(dir('5_5', '5_6', 'straight')).toBe('5_7')
    expect(dir('5_5', '5_6', 'left')).toBe('4_6')
    expect(dir('5_5', '5_6', 'right')).toBe('6_6')
  })

  test('rumbo SUR: recto sigue al sur, izquierda al este, derecha al oeste', () => {
    expect(dir('5_5', '5_4', 'straight')).toBe('5_3')
    expect(dir('5_5', '5_4', 'left')).toBe('6_4')
    expect(dir('5_5', '5_4', 'right')).toBe('4_4')
  })

  // Los dos ejes de la malla: 'calle' (horizontal) y 'carrera' (vertical). Girar dos
  // veces a la izquierda deja el rumbo opuesto — cierra la coherencia de la rotación.
  test('cuatro izquierdas seguidas vuelven al rumbo inicial', () => {
    let a = '5_5', b = '6_5'
    for (let k = 0; k < 4; k++) { const c = dir(a, b, 'left'); a = b; b = c }
    expect([a, b]).toEqual(['5_5', '6_5'])
  })

  test('cuatro derechas seguidas vuelven al rumbo inicial', () => {
    let a = '5_5', b = '6_5'
    for (let k = 0; k < 4; k++) { const c = dir(a, b, 'right'); a = b; b = c }
    expect([a, b]).toEqual(['5_5', '6_5'])
  })

  describe('bordes del mapa (el recto se sale → cae a derecha, luego a izquierda)', () => {
    test('borde ESTE (ci=15): no hay recto, pero sí los dos giros', () => {
      expect(dir('14_5', '15_5', 'straight')).toBeNull()
      expect(dir('14_5', '15_5', 'left')).toBe('15_6')
      expect(dir('14_5', '15_5', 'right')).toBe('15_4')
    })

    test('borde NORTE (ri=12): no hay recto, pero sí los dos giros', () => {
      expect(dir('5_11', '5_12', 'straight')).toBeNull()
      expect(dir('5_11', '5_12', 'left')).toBe('4_12')
      expect(dir('5_11', '5_12', 'right')).toBe('6_12')
    })

    test('borde OESTE (ci=0) y borde SUR (ri=0): tampoco hay recto', () => {
      expect(dir('1_5', '0_5', 'straight')).toBeNull()
      expect(dir('5_1', '5_0', 'straight')).toBeNull()
    })

    // Esquina noreste, grado 2: entrando por el sur solo queda la IZQUIERDA. Es el
    // caso que obliga al último eslabón de la cadena recto → derecha → izquierda.
    test('esquina 15_12 entrando desde el sur: solo sobrevive la izquierda', () => {
      expect(dir('15_11', '15_12', 'straight')).toBeNull()
      expect(dir('15_11', '15_12', 'right')).toBeNull()
      expect(dir('15_11', '15_12', 'left')).toBe('14_12')
    })

    test('esquina 15_12 entrando desde el oeste: solo sobrevive la derecha', () => {
      expect(dir('14_12', '15_12', 'straight')).toBeNull()
      expect(dir('14_12', '15_12', 'left')).toBeNull()
      expect(dir('14_12', '15_12', 'right')).toBe('15_11')
    })
  })

  test('una dirección que no existe se descarta (no inventa vecino)', () => {
    expect(dir('5_5', '6_5', 'u-turn')).toBeNull()
    expect(dir('5_5', '6_5', 'back')).toBeNull()
    expect(dir('5_5', '6_5', undefined)).toBeNull()
  })

  test('un nodo inexistente no revienta: devuelve null', () => {
    expect(dir('99_99', '6_5', 'straight')).toBeNull()
    expect(dir('5_5', '99_99', 'straight')).toBeNull()
  })

  // ── Propiedades sobre la malla COMPLETA (208 nodos, todas las aristas dirigidas) ──
  // Sostienen las tres afirmaciones de las que depende el diseño y que un caso suelto
  // no puede probar.

  test('NINGUNA dirección produce jamás un giro en U (sobre toda la malla)', () => {
    // Un giro en U voltearía la clave de grupo `a>b` a `b>a`: el vehículo dejaría de
    // ver el tráfico de frente y lo atravesaría. Debe ser imposible por construcción.
    for (const [a, b] of directedEdges()) {
      for (const d of ['straight', 'left', 'right']) expect(dir(a, b, d)).not.toBe(a)
    }
  })

  test('todo vecino devuelto es adyacente de verdad en el GRAPH (sobre toda la malla)', () => {
    for (const [a, b] of directedEdges()) {
      for (const d of ['straight', 'left', 'right']) {
        const c = dir(a, b, d)
        if (c === null) continue
        expect(GRAPH[b].some(e => e.to === c)).toBe(true)
        expect(NODES[c]).toBeDefined()
      }
    }
  })

  // Esta es la prueba de que NO existen callejones sin salida y de que, por tanto,
  // _extendLookahead nunca se queda sin nodo que poner. Se afirma sobre el grafo real,
  // no con una rama defensiva en tiempo de ejecución.
  test('la cadena recto → derecha → izquierda SIEMPRE da un nodo (sobre toda la malla)', () => {
    for (const [a, b] of directedEdges()) {
      const next = dir(a, b, 'straight') ?? dir(a, b, 'right') ?? dir(a, b, 'left')
      expect(next).not.toBeNull()
    }
  })
})

// ── El sustrato, ya montado sobre el motor ──
// Estas flotas nacen con freeDrive SOLO acá: en producción nadie lo enciende todavía.

const spawnFleet = (sys, opts) => {
  sys.addFleet(1, { count: 1, spawnBatch: 1, spawnIntervalMs: 100, ...opts })
  sys.invokeFleet(1)
  sys.update(0.1, 0.1)
  // Un vehículo de conducción libre nace QUIETO (el usuario lo mueve con ↑). Los
  // tests de mecánica —ruta, giros, llegada— necesitan el carro andando, así que
  // acá se le pisa el acelerador: sin esto se quedarían mirando un auto detenido y
  // fallarían por una razón que no es la que están probando. El acelerador en sí
  // tiene sus propios tests, aparte.
  for (let i = 0; i < sys.agentCount; i++) if (sys.freeDrive[i]) sys.throttle[i] = 1
}

describe('_spawnOne (la caché de rutas es compartida: nadie puede mutarla)', () => {
  test('un avatar de FLOTA sigue recibiendo el array de _routeCache tal cual', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5' })
    expect(sys.freeDrive[0]).toBe(0)
    // identidad, no igualdad: es el mismo objeto de siempre → comportamiento intacto
    expect(sys.pathNodes[0]).toBe(sys._getCachedRoute('0_0', '5_5'))
  })

  test('un avatar en conducción libre recibe una COPIA propia, nunca la de la caché', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    expect(sys.freeDrive[0]).toBe(1)
    expect(sys.pathNodes[0]).not.toBe(sys._getCachedRoute('0_0', '5_5'))
  })

  test('la ruta sembrada arranca con los primeros saltos de Dijkstra (sale apuntando al destino)', () => {
    const sys = newSystem()
    const cached = sys._getCachedRoute('0_0', '5_5')
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    expect(sys.pathNodes[0].slice(0, 3)).toEqual(cached.slice(0, 3))
  })

  test('destNode guarda el destino REAL, no el final de la ruta recortada', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    expect(sys.destNode[0]).toBe('5_5')
    expect(sys.pathNodes[0][sys.pathNodes[0].length - 1]).not.toBe('5_5')
  })

  test('O/D adyacentes: la ruta se completa hasta sostener la invariante de ≥2 tramos', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '1_0', freeDrive: true })
    expect(sys._getCachedRoute('0_0', '1_0')).toHaveLength(2)   // Dijkstra da 2 nodos
    expect(sys.pathNodes[0].length).toBeGreaterThanOrEqual(3)
    expect(sys.segIndex[0]).toBeLessThanOrEqual(sys.pathNodes[0].length - 3)
  })

  // El daño real de mutar la caché es silencioso y diferido: aparecería en el SIGUIENTE
  // avatar con ese O/D. Se corre la simulación entera y se exige que la caché no se movió.
  test('tras una corrida larga en conducción libre, la caché sigue intacta', () => {
    const sys = newSystem()
    const cached = sys._getCachedRoute('0_0', '5_5')
    const before = [...cached]
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    const sembrada = sys.pathNodes[0].length
    for (let t = 0; t < 600; t++) sys.update(0.1, 0.1 * t)
    expect(sys.pathNodes[0].length).toBeGreaterThan(sembrada)   // su ruta SÍ creció
    expect(cached).toEqual(before)                              // la compartida NO se movió
  })
})

describe('la invariante de ≥2 tramos por delante (lo que mantiene vivo a _stepAgent)', () => {
  // Si se rompe, _stepAgent alcanza su rama terminal: el avatar deja de mirar el
  // semáforo y "llega" en mitad de la calle. Se exige tick a tick.
  test('se sostiene en cada tick de una corrida completa', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    for (let t = 0; t < 600; t++) {
      sys.update(0.1, 0.1 * t)
      expect(sys.segIndex[0]).toBeLessThanOrEqual(sys.pathNodes[0].length - 3)
    }
  })

  test('la ruta crece por delante y el eje de cada tramo nuevo se escribe con ella', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    for (let t = 0; t < 600; t++) sys.update(0.1, 0.1 * t)
    const path = sys.pathNodes[0]
    // pathAxis puede quedar más largo que la ruta (solo se lee en idx < length-2), pero
    // ningún tramo vivo puede quedarse sin eje: el semáforo lo necesita.
    for (let k = 0; k < path.length - 1; k++) expect(sys.pathAxis[0][k]).toMatch(/^(NS|EW)$/)
  })
})

describe('_applyIntent (la intención reescribe el giro del cruce que viene)', () => {
  const armed = () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    return sys
  }

  test('un giro legal reescribe path[segIndex+2] y su eje', () => {
    const sys = armed()
    const path = sys.pathNodes[0]
    const k = sys.segIndex[0]
    const esperado = sys._neighborInDirection(path[k], path[k + 1], 'left')
    expect(sys._applyIntent(0, 'left')).toBe(true)
    expect(sys.pathNodes[0][k + 2]).toBe(esperado)
    expect(sys.pathAxis[0][k + 1]).toMatch(/^(NS|EW)$/)
    expect(sys.intent[0]).toBe('left')
  })

  test('el tramo que se está pisando NO se toca (grupo, occupiedEdges y carril intactos)', () => {
    const sys = armed()
    const k = sys.segIndex[0]
    const [a, b] = [sys.pathNodes[0][k], sys.pathNodes[0][k + 1]]
    sys._applyIntent(0, 'left')
    expect(sys.pathNodes[0][k]).toBe(a)
    expect(sys.pathNodes[0][k + 1]).toBe(b)
  })

  test('un giro ilegal se ignora y conserva el lookahead actual', () => {
    const sys = armed()
    const antes = [...sys.pathNodes[0]]
    expect(sys._applyIntent(0, 'u-turn')).toBe(false)
    expect(sys.pathNodes[0]).toEqual(antes)
    expect(sys.intent[0]).toBeNull()
  })

  // La guarda que hace que el paso 3 sea inerte para las flotas.
  test('sobre un avatar de FLOTA no hace nada (freeDrive = 0)', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5' })
    const antes = [...sys.pathNodes[0]]
    expect(sys._applyIntent(0, 'left')).toBe(false)
    expect(sys.pathNodes[0]).toEqual(antes)
  })

  test('la intención es de un solo uso: se limpia al cruzar', () => {
    const sys = armed()
    sys._applyIntent(0, 'left')
    const desde = sys.segIndex[0]
    for (let t = 0; t < 600 && sys.segIndex[0] === desde; t++) sys.update(0.1, 0.1 * t)
    expect(sys.segIndex[0]).toBeGreaterThan(desde)   // cruzó de verdad
    expect(sys.intent[0]).toBeNull()
  })
})

describe('llegada en conducción libre (dispara por el camino normal de _arrive)', () => {
  // Ruta recta al este: sin intención, el lookahead sigue recto y el destino cae solo.
  const drive = () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '3_0', freeDrive: true })
    for (let t = 0; t < 2000 && sys.arrivedCount === 0; t++) sys.update(0.1, 0.1 * t)
    return sys
  }

  test('llega al destino real, no al nodo de lookahead', () => {
    const sys = drive()
    expect(sys.arrivedCount).toBe(1)
    expect(sys.pathNodes[0][sys.pathNodes[0].length - 1]).toBe('3_0')
  })

  // Si _arrive se llamara con la ruta creciente, el snap teletransportaría el carro
  // hasta el lookahead — un nodo MÁS ALLÁ del destino.
  test('no se teletransporta: queda parado exactamente sobre el destino', () => {
    const sys = drive()
    expect(sys.posX[0]).toBeCloseTo(NODES['3_0'].x, 5)
    expect(sys.posZ[0]).toBeCloseTo(NODES['3_0'].z, 5)
  })

  // El bucle de avance nunca suma el último tramo y _arrive lo remata: la suma tiene
  // que dar exactamente los 3 tramos recorridos, ni uno de más ni de menos.
  test('la distancia recorrida cuadra con los 3 tramos, sin doble conteo', () => {
    const sys = drive()
    expect(sys.distTraveled[0]).toBeCloseTo(90, 4)   // 3 tramos × 30 unidades
  })
})

describe('resetAgents (el estado nuevo también se limpia)', () => {
  test('el reset borra freeDrive, destNode e intent', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    sys._applyIntent(0, 'left')
    expect(sys.freeDrive[0]).toBe(1)

    sys.resetAgents()
    expect(sys.freeDrive[0]).toBe(0)
    expect(sys.destNode[0]).toBeNull()
    expect(sys.intent[0]).toBeNull()
  })

  // Los índices se reusan entre corridas: un acelerador heredado haría arrancar
  // solo al vehículo de la corrida siguiente.
  test('el reset también suelta el acelerador', () => {
    const sys = newSystem()
    spawnFleet(sys, { originId: '0_0', destId: '5_5', freeDrive: true })
    sys.throttle[0] = 1
    sys.resetAgents()
    expect(sys.throttle[0]).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════
//  El cableado del servidor: el vehículo personal conduce libre
// ════════════════════════════════════════════════════════════════

// Una sala con DOS avatares sobre la misma ruta: el carro de flota del usuario 1
// (que se rerutea solo, como siempre) y su vehículo personal (que no). La flota se
// reduce a un solo carro para que la comparación entre los dos sea limpia.
const roomWithBoth = () => {
  const sim = new Simulation('ECCI-9001', 'e0')
  sim.setUserRoute(1, 'T1', 'T3')
  sim.setUserFleet(1, { count: 1, spawnBatch: 1, spawnEvery: 10 })
  sim.invokeFleet(1)
  sim.invokePersonal(1)
  for (let t = 0; t < 10; t++) sim.step(0.05)
  const personal = sim._personalAgent(1)
  let fleet = -1
  for (let i = 0; i < sim.agents.agentCount; i++) if (sim.agents.owner[i] === 1) { fleet = i; break }
  expect(personal).toBeGreaterThanOrEqual(0)   // los dos salieron: sin esto no hay nada que comparar
  expect(fleet).toBeGreaterThanOrEqual(0)
  return { sim, personal, fleet }
}

describe('invokePersonal (el vehículo personal nace en conducción libre)', () => {
  test('el personal tiene freeDrive en 1 y el carro de flota en 0', () => {
    const { sim, personal, fleet } = roomWithBoth()
    expect(sim.agents.freeDrive[personal]).toBe(1)
    expect(sim.agents.freeDrive[fleet]).toBe(0)
  })

  test('sigue siendo prioritario: prioridad y conducción libre no se estorban', () => {
    const { sim } = roomWithBoth()
    const f = sim.agents.fleets.get(1 + 100)
    expect(f.priority).toBe(true)
    expect(f.freeDrive).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════
//  ACELERADOR — el vehículo del usuario NO avanza solo.
//  Es la diferencia entre "mirar una demo" y "manejar", así que si
//  esto se rompe el ajuste entero deja de existir. Y se rompe en
//  silencio: un vehículo que avanza solo se ve perfectamente normal.
// ════════════════════════════════════════════════════════════════
describe('acelerador (sin ↑ el vehículo personal se queda quieto)', () => {
  // Avance total sobre la ruta: el tramo acumulado más lo que lleva del actual.
  const avance = (sim, i) => sim.agents.distTraveled[i] + sim.agents.segDist[i]
  const correr = (sim, segundos) => { for (let t = 0; t < segundos * 20; t++) sim.step(0.05) }

  test('nace quieto: el acelerador arranca en 0', () => {
    const { sim, personal } = roomWithBoth()
    expect(sim.agents.throttle[personal]).toBe(0)
  })

  // EL test del ajuste: tres segundos sin tocar nada y el auto sigue donde estaba.
  test('sin acelerador NO se mueve, por más que corra la simulación', () => {
    const { sim, personal } = roomWithBoth()
    const d0 = avance(sim, personal)
    correr(sim, 3)
    expect(avance(sim, personal)).toBeCloseTo(d0, 4)
    expect(sim.agents.speed[personal]).toBe(0)
  })

  test('con el acelerador SÍ se mueve', () => {
    const { sim, personal } = roomWithBoth()
    const d0 = avance(sim, personal)
    sim.agents.throttle[personal] = 1
    correr(sim, 3)
    expect(avance(sim, personal)).toBeGreaterThan(d0 + 1)
  })

  // El frenado es asintótico —`speed += (0 - speed) * dt*4`, la misma curva con la
  // que el sim frena en un semáforo—, así que la velocidad nunca es exactamente 0
  // y queda un arrastre de ~1e-4 unidades (≈0.4 mm) en tres segundos. La tolerancia
  // es eso: se exige que se DETENGA, no que la exponencial toque el cero.
  test('soltar el acelerador lo frena', () => {
    const { sim, personal } = roomWithBoth()
    sim.agents.throttle[personal] = 1
    correr(sim, 3)
    sim.agents.throttle[personal] = 0
    correr(sim, 2)                       // margen para que la velocidad caiga
    const d = avance(sim, personal)
    correr(sim, 3)
    expect(avance(sim, personal) - d).toBeLessThan(0.01)   // < 4 cm de mundo
  })

  // NO HAY REVERSA, y no por una guarda: el acelerador solo elige entre la
  // velocidad normal y cero, así que el avance es monotónico por construcción.
  test('no hay reversa: el avance nunca retrocede, se acelere o no', () => {
    const { sim, personal } = roomWithBoth()
    let prev = avance(sim, personal)
    for (let t = 0; t < 200; t++) {
      sim.agents.throttle[personal] = t % 20 < 10 ? 1 : 0   // acelerar y soltar, a repetición
      sim.step(0.05)
      const d = avance(sim, personal)
      expect(d).toBeGreaterThanOrEqual(prev - 1e-6)
      prev = d
    }
  })

  // La flota tiene freeDrive en 0, así que el acelerador no la toca NUNCA: es la
  // misma garantía por construcción que sostiene todo el sustrato.
  test('la flota sigue andando sola: el acelerador es solo de la conducción libre', () => {
    const { sim, fleet } = roomWithBoth()
    expect(sim.agents.freeDrive[fleet]).toBe(0)
    expect(sim.agents.throttle[fleet]).toBe(0)   // apagado, y aun así avanza
    const d0 = avance(sim, fleet)
    correr(sim, 3)
    expect(avance(sim, fleet)).toBeGreaterThan(d0 + 1)
  })

  // Un auto parado por su dueño es la parada más legítima que hay. Sin esto,
  // soltar la tecla unos segundos lo haría declararse atascado él solo (y en el
  // dashboard del admin aparecería un atasco que no existe).
  test('parado sin acelerador NO se declara atascado', () => {
    const { sim, personal } = roomWithBoth()
    correr(sim, 12)                      // bastante más que STUCK_TIME
    expect(sim.agents.stuckAccum[personal]).toBe(0)
    expect(sim.agents.state[personal]).not.toBe(AGENT_STATE.STUCK)
  })
})

// ════════════════════════════════════════════════════════════════
//  RUTA VIVA (la línea punteada) — la ruta más rápida DADOS los
//  eventos, contra la sólida del cliente, que es la más rápida como
//  si no hubiera pasado nada. Que las dos se separen ES la demo: sin
//  esto, una zona roja de Spark no se ve influir en ninguna decisión.
// ════════════════════════════════════════════════════════════════
// Índice de una zona que la ruta ATRAVIESA por una arista (no solo por un nodo):
// es la única clase de zona cuya penalización puede desviarla. Se descarta la que
// contiene el arranque, porque desde ahí ya no hay alternativa que elegir.
const zonaSobreLaRuta = (sim, ruta) => {
  const pares = new Set()
  for (let k = 0; k < ruta.length - 1; k++) pares.add(`${ruta[k]}|${ruta[k + 1]}`)
  for (let z = 0; z < sim.zones.zoneEdges.length; z++) {
    if (sim.zones.zoneNodeIds[z]?.has(ruta[0])) continue
    for (const e of sim.zones.zoneEdges[z]) {
      if (pares.has(`${e.a}|${e.b}`) || pares.has(`${e.b}|${e.a}`)) return z
    }
  }
  return -1
}

describe('ruta sugerida (drive_state.route)', () => {
  test('drive_state la trae, y arranca en el cruce que viene', () => {
    const { sim, personal } = roomWithBoth()
    const msg = sim._driveStateFor(personal)
    expect(Array.isArray(msg.route)).toBe(true)
    expect(msg.route.length).toBeGreaterThan(1)
    // Arranca en nextNode y NO en el nodo de atrás: entre dos cruces ya no se elige,
    // así que sugerir desde atrás pediría un giro imposible.
    expect(msg.route[0]).toBe(msg.nextNode)
  })

  test('termina en el destino REAL, no en el lookahead de la ruta libre', () => {
    const { sim, personal } = roomWithBoth()
    const msg = sim._driveStateFor(personal)
    expect(msg.route[msg.route.length - 1]).toBe(sim.agents.destNode[personal])
  })

  // EL test de la feature: una zona roja de Spark tiene que MOVER la línea.
  test('una zona roja de Spark cambia la ruta sugerida', () => {
    const { sim, personal } = roomWithBoth()
    const antes = sim._driveStateFor(personal).route
    // Se pinta de rojo una zona que la ruta actual atraviesa (si la zona no estuviera
    // sobre la ruta, no habría por qué desviarse y el test no probaría nada).
    // La zona se elige por sus ARISTAS y no por sus nodos: applySparkRedZones
    // penaliza `zoneEdges`, y hay zonas con nodos pero SIN aristas — pintarlas de
    // rojo no penaliza nada y la ruta no se movería.
    const zona = zonaSobreLaRuta(sim, antes)
    expect(zona).toBeGreaterThanOrEqual(0)   // sin una zona sobre la ruta no hay nada que probar

    sim.applySparkRedZones([zona])
    sim.time += 1                            // vencer el cache de SUGGEST_EVERY_S
    const despues = sim._driveStateFor(personal).route
    expect(despues.join('>')).not.toBe(antes.join('>'))
  })

  // La sólida del cliente corre sobre el grafo LIMPIO, así que una zona roja NO
  // puede moverla: si esto se rompe, las dos líneas serían la misma y no habría
  // contraste que mostrar.
  test('la zona roja NO toca la ruta ideal (la sólida se calcula sin eventos)', () => {
    const { sim, personal } = roomWithBoth()
    const ideal = dijkstra(sim.agents.pathNodes[personal][1], sim.agents.destNode[personal])
    const zona = zonaSobreLaRuta(sim, ideal)
    expect(zona).toBeGreaterThanOrEqual(0)
    sim.applySparkRedZones([zona])
    const idealDespues = dijkstra(sim.agents.pathNodes[personal][1], sim.agents.destNode[personal])
    expect(idealDespues.join('>')).toBe(ideal.join('>'))
  })

  test('el cache no la deja rancia: al vencer SUGGEST_EVERY_S se recalcula', () => {
    const { sim, personal } = roomWithBoth()
    sim._driveStateFor(personal)
    const cache1 = sim._suggestCache.get(personal)
    sim._driveStateFor(personal)
    expect(sim._suggestCache.get(personal).at).toBe(cache1.at)   // dentro de la ventana: no recalcula
    sim.time += 1
    sim._driveStateFor(personal)
    expect(sim._suggestCache.get(personal).at).toBeGreaterThan(cache1.at)
  })
})

describe('setDriveThrottle (el acelerador, validado en el servidor)', () => {
  test('acelera y suelta el vehículo personal del slot', () => {
    const { sim, personal } = roomWithBoth()
    expect(sim.setDriveThrottle(1, true)).toBe(true)
    expect(sim.agents.throttle[personal]).toBe(1)
    expect(sim.setDriveThrottle(1, false)).toBe(true)
    expect(sim.agents.throttle[personal]).toBe(0)
  })

  test('un slot sin vehículo personal no acelera nada', () => {
    const { sim } = roomWithBoth()
    expect(sim.setDriveThrottle(2, true)).toBe(false)
  })

  // El acelerador de un usuario no puede mover el vehículo de otro.
  test('el acelerador solo toca al vehículo del slot que lo pide', () => {
    const sim = new Simulation('ECCI-9500', 'e0')
    for (const slot of [1, 2]) { sim.setUserRoute(slot, 'T1', 'T3'); sim.invokePersonal(slot) }
    for (let t = 0; t < 10; t++) sim.step(0.05)
    sim.setDriveThrottle(1, true)
    expect(sim.agents.throttle[sim._personalAgent(1)]).toBe(1)
    expect(sim.agents.throttle[sim._personalAgent(2)]).toBe(0)
  })
})

// ── El test que importa: si el gancho se cae, esto es lo único que lo grita ──
describe('onRerouteIntercept (el reruteo automático no puede pisar el volante)', () => {
  test('zona roja de Spark: desvía a la flota y NO toca al vehículo personal', () => {
    const { sim, personal, fleet } = roomWithBoth()
    // Una zona roja SOBRE la ruta que los dos comparten (el nodo 2 sale del mismo
    // Dijkstra en ambos), por el camino de producción: penaliza y luego rerutea.
    const shared = sim.agents.pathNodes[fleet][2]
    expect(sim.agents.pathNodes[personal][2]).toBe(shared)
    const n = NODES[shared]
    const antesPersonal = [...sim.agents.pathNodes[personal]]
    const antesFlota = [...sim.agents.pathNodes[fleet]]

    sim.applySparkRedZones([sim.zones.zoneIndexAt(n.x, n.z)])

    expect(sim.agents.pathNodes[fleet]).not.toEqual(antesFlota)      // la flota SÍ se desvía
    expect(sim.agents.pathNodes[personal]).toEqual(antesPersonal)    // el volante sobrevive
  })

  test('incidente: desvía a la flota y NO toca al vehículo personal', () => {
    const { sim, personal, fleet } = roomWithBoth()
    // La arista que nace del cruce que viene: está en la ruta RESTANTE de los dos.
    const [a, b] = [sim.agents.pathNodes[fleet][1], sim.agents.pathNodes[fleet][2]]
    expect(sim.agents.pathNodes[personal].slice(1, 3)).toEqual([a, b])
    const antesPersonal = [...sim.agents.pathNodes[personal]]
    const antesFlota = [...sim.agents.pathNodes[fleet]]

    setEdgeBlocked(a, b, true, sim.graphState)   // lo mismo que hace IncidentManager
    sim.agents.rerouteAgentsThroughEdge(a, b)

    expect(sim.agents.pathNodes[fleet]).not.toEqual(antesFlota)
    expect(sim.agents.pathNodes[personal]).toEqual(antesPersonal)
  })

  // La ruta de una conducción libre es un array PROPIO que crece con push(): no basta
  // con que el contenido coincida, el objeto no puede ser reemplazado.
  test('la ruta del personal sigue siendo el MISMO array (no la reemplaza un Dijkstra)', () => {
    const { sim, personal, fleet } = roomWithBoth()
    const array = sim.agents.pathNodes[personal]
    const [a, b] = [sim.agents.pathNodes[fleet][1], sim.agents.pathNodes[fleet][2]]
    setEdgeBlocked(a, b, true, sim.graphState)
    sim.agents.rerouteAgentsThroughEdge(a, b)
    expect(sim.agents.pathNodes[personal]).toBe(array)
  })

  test('el gancho intercepta los tres motivos, y solo en conducción libre', () => {
    const { sim, personal, fleet } = roomWithBoth()
    for (const motivo of ['atascado', 'zona_roja', 'incidente']) {
      expect(sim.agents.onRerouteIntercept(personal, motivo)).toBe(true)
      expect(sim.agents.onRerouteIntercept(fleet, motivo)).toBe(false)
    }
  })

  // El gancho se instala en el constructor y _reset() NO recrea el AgentSystem; si
  // alguna vez lo recreara, el volante moriría en el primer reset del admin.
  test('sobrevive al reset del admin', () => {
    const { sim } = roomWithBoth()
    sim.control('reset')
    sim.invokePersonal(1)
    for (let t = 0; t < 10; t++) sim.step(0.05)
    const personal = sim._personalAgent(1)
    expect(sim.agents.onRerouteIntercept(personal, 'atascado')).toBe(true)
  })
})

describe('setDriveIntent (el volante, validado en el servidor)', () => {
  test('un giro legal se aplica sobre el vehículo personal del slot', () => {
    const { sim, personal } = roomWithBoth()
    const path = sim.agents.pathNodes[personal]
    const k = sim.agents.segIndex[personal]
    const esperado = sim.agents._neighborInDirection(path[k], path[k + 1], 'left')
    expect(sim.setDriveIntent(1, 'left')).toBe(true)
    expect(sim.agents.pathNodes[personal][k + 2]).toBe(esperado)
    expect(sim.agents.intent[personal]).toBe('left')
  })

  test('una dirección que no es de las tres se rechaza', () => {
    const { sim, personal } = roomWithBoth()
    for (const dir of ['u-turn', 'LEFT', '', null, undefined, 0, { dir: 'left' }]) {
      expect(sim.setDriveIntent(1, dir)).toBe(false)
    }
    expect(sim.agents.intent[personal]).toBeNull()
  })

  // La malla manda: un giro que no existe en el GRAPH no se puede expresar desde el
  // cliente, aunque la literal sea válida.
  test('un giro legal como literal pero inexistente en la malla se rechaza', () => {
    const sim = new Simulation('ECCI-9002', 'e0')
    sim.setUserRoute(1, 'T1', 'T3')
    sim.invokePersonal(1)
    for (let t = 0; t < 10; t++) sim.step(0.05)
    const i = sim._personalAgent(1)
    // Se lo pone de frente al borde norte del mapa: el cruce que viene es 5_12 y
    // allí el recto (5_13) no tiene arista.
    sim.agents.pathNodes[i] = ['5_11', '5_12', '4_12']
    sim.agents.segIndex[i] = 0
    expect(sim.agents._neighborInDirection('5_11', '5_12', 'straight')).toBeNull()
    expect(sim.setDriveIntent(1, 'straight')).toBe(false)
    expect(sim.setDriveIntent(1, 'left')).toBe(true)
  })

  test('un slot sin vehículo personal vivo no aplica nada', () => {
    const { sim } = roomWithBoth()
    expect(sim.setDriveIntent(2, 'left')).toBe(false)   // el usuario 2 nunca invocó
    expect(sim.setDriveIntent(3, 'left')).toBe(false)
  })

  test('el volante de un slot no toca el vehículo de otro', () => {
    const sim = new Simulation('ECCI-9003', 'e0')
    for (const slot of [1, 2]) {
      sim.setUserRoute(slot, 'T1', 'T3')
      sim.invokePersonal(slot)
    }
    for (let t = 0; t < 10; t++) sim.step(0.05)
    const a = sim._personalAgent(1), b = sim._personalAgent(2)
    expect(a).not.toBe(b)
    expect(sim.setDriveIntent(1, 'left')).toBe(true)
    expect(sim.agents.intent[a]).toBe('left')
    expect(sim.agents.intent[b]).toBeNull()
  })
})

describe('drive_state (dirigido al dueño, y solo cuando cambia)', () => {
  const drained = sim => sim.drainOutbox().filter(o => o.msg.type === 'drive_state')

  test('llega al dueño con el cruce que viene y los giros que existen ahí', () => {
    const { sim, personal } = roomWithBoth()
    const [out] = drained(sim)
    expect(out).toBeDefined()
    expect(out.to).toBe(1)                    // al slot dueño, no al admin ni a todos
    expect(out.msg.vehicleId).toBe(personal)
    expect(out.msg.nextNode).toBe(sim.agents.pathNodes[personal][sim.agents.segIndex[personal] + 1])
    expect(out.msg.pending).toBeNull()        // sin pedir nada: sigue recto
    expect(out.msg.blockedAhead).toBe(false)
    // Los giros anunciados son los que la malla tiene de verdad
    const path = sim.agents.pathNodes[personal]
    const k = sim.agents.segIndex[personal]
    for (const d of ['left', 'straight', 'right']) {
      expect(out.msg.options[d]).toBe(sim.agents._neighborInDirection(path[k], path[k + 1], d) !== null)
    }
  })

  test('sin cambios NO se reemite: no es un canal de 20 Hz', () => {
    const { sim } = roomWithBoth()
    drained(sim)
    for (let t = 0; t < 10; t++) sim.step(0.05)   // medio segundo = 10 ticks
    expect(drained(sim)).toHaveLength(0)
  })

  test('una intención aceptada emite un estado nuevo con pending', () => {
    const { sim } = roomWithBoth()
    drained(sim)
    sim.setDriveIntent(1, 'left')
    sim.step(0.05)
    const [out] = drained(sim)
    expect(out.msg.pending).toBe('left')
  })

  test('un bloqueo por incidente delante se anuncia, y se apaga al expirar', () => {
    const { sim, personal } = roomWithBoth()
    drained(sim)
    const path = sim.agents.pathNodes[personal]
    const k = sim.agents.segIndex[personal]
    const [a, b] = [path[k + 1], path[k + 2]]

    setEdgeBlocked(a, b, true, sim.graphState)
    sim.step(0.05)
    expect(drained(sim)[0].msg.blockedAhead).toBe(true)

    setEdgeBlocked(a, b, false, sim.graphState)
    sim.step(0.05)
    expect(drained(sim)[0].msg.blockedAhead).toBe(false)
  })

  test('los avatares de flota no generan drive_state', () => {
    const sim = new Simulation('ECCI-9004', 'e0')
    sim.setUserRoute(1, 'T1', 'T3')
    sim.invokeFleet(1)   // flota sola: nadie invocó el personal
    for (let t = 0; t < 40; t++) sim.step(0.05)
    expect(drained(sim)).toHaveLength(0)
  })

  test('el reset olvida lo enviado: la próxima invocación vuelve a emitir', () => {
    const { sim } = roomWithBoth()
    drained(sim)
    sim.control('reset')
    sim.invokePersonal(1)
    for (let t = 0; t < 10; t++) sim.step(0.05)
    expect(drained(sim)).toHaveLength(1)
  })
})

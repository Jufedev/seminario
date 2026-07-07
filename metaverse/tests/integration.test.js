// Tests de la integración Kafka del metaverso (bun test — sin Kafka ni Spark).
// Blindan las propiedades load-bearing que las revisiones marcaron como riesgo:
//  · velocidad MEDIDA (un avatar detenido DEBE reportar ~0, o Spark queda ciego),
//  · mapeo coord→zona 6×6,
//  · RedPointStore: un renombre de campo de Spark NO debe pasar en silencio.
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { measuredSpeedMps } from '../server/speed.js'
import { GRID_SIZE, zoneIndexAt } from '../server/zoneGrid.js'
import { RedPointStore } from '../analytics/redPoints.js'

const UNIT_TO_METERS = 4
const LAST_CELL = GRID_SIZE * GRID_SIZE - 1 // 35

describe('measuredSpeedMps (propiedad crítica de la tesis)', () => {
  test('sin desplazamiento → 0 m/s (auto encolado / detenido)', () => {
    expect(measuredSpeedMps(0, 0, 1, UNIT_TO_METERS)).toBe(0)
  })

  test('en movimiento → m/s medidos desde el desplazamiento', () => {
    expect(measuredSpeedMps(3, 0, 1, UNIT_TO_METERS)).toBeCloseTo(12, 5) // 3u/s × 4
    expect(measuredSpeedMps(0, 3, 1, UNIT_TO_METERS)).toBeCloseTo(12, 5)
    expect(measuredSpeedMps(3, 4, 1, UNIT_TO_METERS)).toBeCloseTo(20, 5) // hypot(3,4)=5 × 4
  })

  test('un avatar casi inmóvil queda bajo el umbral 0.5 m/s del detector', () => {
    expect(measuredSpeedMps(0.02, 0, 1, UNIT_TO_METERS)).toBeLessThan(0.5)
  })

  test('un dt diminuto se clampa (sin división por cero)', () => {
    expect(Number.isFinite(measuredSpeedMps(1, 0, 0, UNIT_TO_METERS))).toBe(true)
  })
})

describe('zoneIndexAt (coords de mundo → celda del overlay 6×6)', () => {
  test('la grilla es 6×6', () => {
    expect(GRID_SIZE).toBe(6)
  })

  test('las esquinas mapean a la primera y última celda', () => {
    expect(zoneIndexAt(-225, -180)).toBe(0)
    expect(zoneIndexAt(224, 179)).toBe(LAST_CELL)
  })

  test('coords fuera de rango se clampan, nunca lanzan', () => {
    expect(zoneIndexAt(-99999, -99999)).toBe(0)
    expect(zoneIndexAt(99999, 99999)).toBe(LAST_CELL)
  })

  test('siempre devuelve un entero en [0, 35]', () => {
    for (const [x, z] of [[0, 0], [100, -50], [-200, 150]]) {
      const zone = zoneIndexAt(x, z)
      expect(Number.isInteger(zone)).toBe(true)
      expect(zone).toBeGreaterThanOrEqual(0)
      expect(zone).toBeLessThanOrEqual(LAST_CELL)
    }
  })
})

describe('RedPointStore (red-points de Spark → zonas activas por sala)', () => {
  const fakeBridge = () => ({ mode: 'local', emitter: new EventEmitter() })
  const sparkRedPoint = (cx, cy, room) => ({
    room,
    cell_x: 1, cell_y: 1, center_x: cx, center_y: cy,
    stationary_avatars: 7,
    window_start: '2026-07-07 12:00:00', window_end: '2026-07-07 12:01:00',
  })

  test('un red-point bien formado activa su zona en su sala', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
  })

  test('las zonas son POR sala: otra sala no ve las de una sala ajena', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    expect(store.activeZonesFor('ECCI-9999')).toHaveLength(0)
  })

  test('un red-point sin sala cae en GLOBAL y lo ven todas las salas', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0)) // sin room
    expect(store.activeZonesFor('ECCI-1234')).toContain(zoneIndexAt(0, 0))
    expect(store.activeZonesFor('ECCI-9999')).toContain(zoneIndexAt(0, 0))
  })

  test('un campo center renombrado NO produce zona (guarda contra renombre silencioso)', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest({ room: 'ECCI-1234', cell_x: 1, cell_y: 1, centerX: 0, centerY: 0, stationary_avatars: 7 })
    expect(store.activeZonesFor('ECCI-1234')).toHaveLength(0)
  })

  test('una zona expirada se poda de activeZonesFor y del mapa de la sala', () => {
    const store = new RedPointStore({ bridge: fakeBridge() })
    store._ingest(sparkRedPoint(0, 0, 'ECCI-1234'))
    const zone = zoneIndexAt(0, 0)
    store.zones.get('ECCI-1234').set(zone, Date.now() - 1) // forzar expiración
    expect(store.activeZonesFor('ECCI-1234')).not.toContain(zone)
    expect(store.zones.has('ECCI-1234')).toBe(false) // sala sin zonas vivas → se descarta
  })
})

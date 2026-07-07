// ════════════════════════════════════════════════════════════════
//  INTERPOLACIÓN — el servidor manda world_snapshot a 20 Hz; el
//  cliente dibuja a 60 fps interpolando entre los DOS snapshots que
//  encierran el instante de render (que va ~120ms detrás del servidor,
//  para tener siempre un par completo aunque la red tenga jitter).
//  Sin extrapolación: si no llegan snapshots, el mundo se CONGELA —
//  eso hace visible que el movimiento es del servidor, no del cliente.
// ════════════════════════════════════════════════════════════════
const STRIDE = 6   // formato del array plano: [id, x, z, heading, state, owner]

function lerpAngle(a, b, t) {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

export class SnapshotInterpolator {
  constructor(delayMs = 120) {
    this.delay = delayMs / 1000
    this.buf = []          // snapshots parseados, orden cronológico
    this.offset = null     // reloj_servidor − reloj_cliente (suavizado)
  }

  push(snap) {
    // Corrida nueva o tiempo hacia atrás (reinicio del server) → el estado no es
    // compatible con lo bufferizado: se vacía y se re-sincroniza el reloj
    const last = this.buf[this.buf.length - 1]
    if (last && (snap.run !== last.run || snap.time < last.time)) {
      this.buf.length = 0
      this.offset = null
    }
    // array plano → Map id → registro (rápido de buscar al interpolar)
    const m = new Map()
    for (let k = 0; k < snap.a.length; k += STRIDE) {
      m.set(snap.a[k], { x: snap.a[k + 1], z: snap.a[k + 2], h: snap.a[k + 3], s: snap.a[k + 4], o: snap.a[k + 5] })
    }
    this.buf.push({ run: snap.run, time: snap.time, m })
    if (this.buf.length > 60) this.buf.shift()   // ~3s de historia, de sobra

    // Estimar el offset de reloj con suavizado leve (aguanta jitter de red)
    const off = snap.time - performance.now() / 1000
    this.offset = this.offset == null ? off : this.offset + (off - this.offset) * 0.1
  }

  // Estado interpolado para AHORA: [{id, x, z, h, s}] o null si aún no hay datos
  sample() {
    if (!this.buf.length || this.offset == null) return null
    const t = performance.now() / 1000 + this.offset - this.delay

    let s0 = this.buf[0], s1 = this.buf[this.buf.length - 1]
    if (t <= s0.time) s1 = s0
    else if (t >= s1.time) s0 = s1              // sin datos frescos: congelar en el último
    else for (let i = this.buf.length - 1; i > 0; i--) {
      if (this.buf[i - 1].time <= t) { s0 = this.buf[i - 1]; s1 = this.buf[i]; break }
    }
    const span = s1.time - s0.time
    const alpha = span > 0 ? (t - s0.time) / span : 1

    const out = []
    for (const [id, b] of s1.m) {
      const a = s0.m.get(id)
      if (!a) { out.push({ id, x: b.x, z: b.z, h: b.h, s: b.s, o: b.o }); continue }   // recién spawneado
      out.push({
        id,
        x: a.x + (b.x - a.x) * alpha,
        z: a.z + (b.z - a.z) * alpha,
        h: lerpAngle(a.h, b.h, alpha),
        s: b.s,
        o: b.o,
      })
    }
    return out
  }
}

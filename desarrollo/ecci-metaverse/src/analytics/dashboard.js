import { UNIT_TO_METERS } from '../graph/mapData.js'
import { AGENT_STATE } from '../sim/agents.js'
import { INCIDENT_TYPES } from '../sim/incidents.js'
import { ANALYTICS_CONFIG as CFG } from './config.js'

// ════════════════════════════════════════════════════════════════
//  DASHBOARD — panel de analítica en vivo (Chart.js vía CDN, ver index.html)
//  Muestrea cada ~1s (ANALYTICS_CONFIG.DASHBOARD_SAMPLE_S), NUNCA por frame.
//  Al terminar la simulación se congela y queda como resumen final.
// ════════════════════════════════════════════════════════════════

// Paleta de series (categórica, distinta de los colores de estado ya usados
// en la simulación: azul=moviéndose, ámbar=espera, rojo=atasco/zona roja, verde=llegó)
const COLOR = {
  atascado: '#199e70',    // aqua
  zonaRoja: '#d95926',    // naranja
  redLine: '#f87171',     // rojo de estado — coherente con "zona roja" en el mundo 3D
  incidentLine: '#d95926',
  speedLine: '#3b82f6',
  ink: '#c3c2b7',
  grid: 'rgba(255,255,255,0.08)',
}

function fmtTime(s) {
  if (s == null || !isFinite(s)) return '—'
  const m = Math.floor(s / 60), ss = Math.round(s % 60)
  return m > 0 ? `${m}m ${ss}s` : `${ss}s`
}
function fmtDist(m) { return m == null || !isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m` }

// ── Estadísticas de llegada: promedio, desviación estándar, primero vs último ──
// σ = sqrt( Σ(tᵢ − t̄)² / N )   —  E = distancia_óptima / distancia_real
function computeArrivalStats(as, optimalMeters) {
  let n = 0, sumT = 0, sumDist = 0
  const times = []
  let first = null, last = null
  for (let i = 0; i < as.total; i++) {
    if (!as.active[i] || as.state[i] !== AGENT_STATE.ARRIVED) continue
    const t = as.arriveTime[i] - as.spawnTime[i]
    const dist = as.distTraveled[i] * UNIT_TO_METERS
    times.push(t); sumT += t; sumDist += dist; n++
    if (!first || as.arriveTime[i] < first.arriveTime) first = { i, t, dist, arriveTime: as.arriveTime[i] }
    if (!last || as.arriveTime[i] > last.arriveTime) last = { i, t, dist, arriveTime: as.arriveTime[i] }
  }
  const meanT = n ? sumT / n : null
  const variance = n ? times.reduce((s, t) => s + (t - meanT) ** 2, 0) / n : 0
  const stdDev = n ? Math.sqrt(variance) : null
  const avgDist = n ? sumDist / n : null
  const efficiency = avgDist ? optimalMeters / avgDist : null
  return { n, total: as.total, meanT, stdDev, avgDist, efficiency, first, last, pctArrived: as.total ? (n / as.total) * 100 : 0 }
}

export class Dashboard {
  constructor(container, { agentSystem, zoneSystem, incidentManager, optimalDistanceMeters }) {
    this.as = agentSystem
    this.zones = zoneSystem
    this.incidents = incidentManager
    this.optimalMeters = optimalDistanceMeters
    this.finalized = false
    this._acc = 0
    this._samples = { t: [], red: [], inc: [], speed: [] }

    this._buildDom(container)
    this._buildCharts()
  }

  _buildDom(container) {
    const el = document.createElement('div')
    el.className = 'dash-root'
    el.innerHTML = `
      <button id="dash-toggle" class="btn secondary dash-fab">📊 Analítica</button>
      <div id="dash-panel" class="panel dash-panel">
        <div class="dash-head">
          <h3 id="dash-title">📊 Analítica en vivo</h3>
          <div style="display:flex;gap:8px">
            <button id="dash-finish" class="btn secondary" style="padding:6px 12px;font-size:12px">Finalizar simulación</button>
            <button id="dash-close" class="btn secondary" style="padding:6px 10px;font-size:12px">✕</button>
          </div>
        </div>
        <div class="dash-kpis" id="dash-kpis">
          <div class="kpi-tile"><div class="kpi-val" id="k-arrived-pct">0%</div><div class="kpi-lbl">% llegaron</div></div>
          <div class="kpi-tile"><div class="kpi-val" id="k-mean-time">—</div><div class="kpi-lbl">Tiempo prom. llegada</div></div>
          <div class="kpi-tile"><div class="kpi-val" id="k-std-time">—</div><div class="kpi-lbl">Desv. estándar σ</div></div>
          <div class="kpi-tile"><div class="kpi-val" id="k-efficiency">—</div><div class="kpi-lbl">Score eficiencia E</div></div>
          <div class="kpi-tile"><div class="kpi-val" id="k-congestion">—</div><div class="kpi-lbl">Congestión global C̄</div></div>
          <div class="kpi-tile"><div class="kpi-val" id="k-worst-zone">—</div><div class="kpi-lbl">Zona más congestionada</div></div>
        </div>
        <div class="dash-grid">
          <div class="dash-card"><h4>Recálculos de ruta por motivo</h4><div class="dash-chart-wrap"><canvas id="c-recalc"></canvas></div></div>
          <div class="dash-card"><h4>Incidentes por tipo</h4><div class="dash-chart-wrap"><canvas id="c-inc-type"></canvas></div></div>
          <div class="dash-card"><h4>Zonas rojas activas</h4><div class="dash-chart-wrap"><canvas id="c-zones-time"></canvas></div></div>
          <div class="dash-card"><h4>Incidentes activos</h4><div class="dash-chart-wrap"><canvas id="c-inc-time"></canvas></div></div>
          <div class="dash-card"><h4>Velocidad promedio de la flota</h4><div class="dash-chart-wrap"><canvas id="c-speed-time"></canvas></div></div>
          <div class="dash-card">
            <h4>Mapa de calor de congestión (6×6)</h4>
            <canvas id="c-heatmap" class="dash-heatmap"></canvas>
          </div>
          <div class="dash-card wide">
            <h4>Primero vs último avatar en llegar</h4>
            <table class="dash-table">
              <tr><th></th><th>🥇 Primero</th><th>🏁 Último</th></tr>
              <tr><td>Tiempo de viaje</td><td id="t-first-time">—</td><td id="t-last-time">—</td></tr>
              <tr><td>Distancia recorrida</td><td id="t-first-dist">—</td><td id="t-last-dist">—</td></tr>
            </table>
          </div>
        </div>
        <div class="dash-formulas">
          <span>C = 0.4·ρ + 0.3·incidentes + 0.3·(1 − v̄/v_libre)</span>
          <span>ρ = avatares_zona / capacidad_zona</span>
          <span>E = distancia_óptima / distancia_real</span>
          <span>σ = √(Σ(tᵢ − t̄)² / N)</span>
        </div>
      </div>
    `
    container.appendChild(el)
    this.root = el
    this.panel = el.querySelector('#dash-panel')
    el.querySelector('#dash-toggle').addEventListener('click', () => this.toggle())
    el.querySelector('#dash-close').addEventListener('click', () => this.toggle(false))
    el.querySelector('#dash-finish').addEventListener('click', () => this.finalize())
  }

  toggle(force) {
    const show = force ?? this.panel.classList.contains('hidden')
    this.panel.classList.toggle('hidden', !show)
  }

  _buildCharts() {
    if (!window.Chart) { console.warn('[Dashboard] Chart.js no cargó (revisa el <script> CDN en index.html)'); return }
    Chart.defaults.color = COLOR.ink
    Chart.defaults.borderColor = COLOR.grid
    Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif"
    Chart.defaults.font.size = 11

    const bar = (id, labels, colors) => new Chart(this.root.querySelector(id), {
      type: 'bar',
      data: { labels, datasets: [{ data: labels.map(() => 0), backgroundColor: colors, borderRadius: 4, maxBarThickness: 44 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: COLOR.grid } } },
      },
    })
    const line = (id, color) => new Chart(this.root.querySelector(id), {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: color + '33', fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true, grid: { color: COLOR.grid } } },
      },
    })

    this.chartRecalc = bar('#c-recalc', ['Atascado', 'Zona roja'], [COLOR.atascado, COLOR.zonaRoja])
    this.chartIncType = bar('#c-inc-type', INCIDENT_TYPES.map(t => t.label), INCIDENT_TYPES.map(t => '#' + t.color.toString(16).padStart(6, '0')))
    this.chartZonesTime = line('#c-zones-time', COLOR.redLine)
    this.chartIncTime = line('#c-inc-time', COLOR.incidentLine)
    this.chartSpeedTime = line('#c-speed-time', COLOR.speedLine)
  }

  // ── Ciclo por frame: solo muestrea/redibuja cada DASHBOARD_SAMPLE_S segundos ──
  update(dt, simTime) {
    if (this.finalized) return
    this._acc += dt
    if (this._acc < CFG.DASHBOARD_SAMPLE_S) return
    this._acc = 0
    this._sample(simTime)
    this._refreshLiveKpis()
  }

  _sample(simTime) {
    const s = this._samples
    const redCount = this.zones.getRedCount()
    const incCount = this.incidents.getActiveCount()
    const avgSpeed = this.as.getStats().avgSpeedMps

    s.t.push(simTime.toFixed(0)); s.red.push(redCount); s.inc.push(incCount); s.speed.push(+avgSpeed.toFixed(1))
    if (s.t.length > CFG.DASHBOARD_MAX_SAMPLES) { s.t.shift(); s.red.shift(); s.inc.shift(); s.speed.shift() }

    if (!this.chartRecalc) return   // Chart.js no disponible: solo se actualizan los KPI de texto
    this.chartRecalc.data.datasets[0].data = [this.as.rerouteByReason.atascado, this.as.rerouteByReason.zona_roja]
    this.chartRecalc.update('none')

    this.chartIncType.data.datasets[0].data = INCIDENT_TYPES.map(t => this.incidents.typeCounts[t.id])
    this.chartIncType.update('none')

    this.chartZonesTime.data.labels = s.t; this.chartZonesTime.data.datasets[0].data = s.red; this.chartZonesTime.update('none')
    this.chartIncTime.data.labels = s.t; this.chartIncTime.data.datasets[0].data = s.inc; this.chartIncTime.update('none')
    this.chartSpeedTime.data.labels = s.t; this.chartSpeedTime.data.datasets[0].data = s.speed; this.chartSpeedTime.update('none')

    this._drawHeatmap()
  }

  _drawHeatmap() {
    const canvas = this.root.querySelector('#c-heatmap')
    const ctx = canvas.getContext('2d')
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    ctx.clearRect(0, 0, w, h)
    const g = CFG.GRID_SIZE, cw = w / g, ch = h / g
    for (const z of this.zones.getSnapshot()) {
      const t = Math.min(1, z.avgC)
      // Interpola gris-azulado (bajo) → rojo (alto), consistente con el overlay 3D
      const r = Math.round(42 + t * (248 - 42)), gg = Math.round(58 + t * (113 - 58)), b = Math.round(79 + t * (113 - 79))
      ctx.fillStyle = `rgb(${r},${gg},${b})`
      const x = z.zx * cw, y = z.zz * ch   // zz crece hacia el sur → hacia abajo, igual que en el mapa
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2)
      if (z.isRed) { ctx.strokeStyle = COLOR.redLine; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2) }
    }
  }

  // KPIs que tienen sentido "en vivo" (van cambiando a medida que llegan avatares)
  _refreshLiveKpis() {
    const stats = computeArrivalStats(this.as, this.optimalMeters)
    this.root.querySelector('#k-arrived-pct').textContent = `${stats.pctArrived.toFixed(0)}%`
    this.root.querySelector('#k-mean-time').textContent = fmtTime(stats.meanT)
    this.root.querySelector('#k-std-time').textContent = stats.stdDev != null ? `${stats.stdDev.toFixed(1)}s` : '—'
    this.root.querySelector('#k-efficiency').textContent = stats.efficiency != null ? stats.efficiency.toFixed(2) : '—'
    this.root.querySelector('#k-congestion').textContent = this.zones.getGlobalCongestionIndex().toFixed(2)
    const worst = this.zones.getMostCongestedZone()
    this.root.querySelector('#k-worst-zone').textContent = worst ? `Zona (${worst.zx + 1},${worst.zz + 1}) · C̄=${worst.avgC.toFixed(2)}` : '—'

    if (stats.first) {
      this.root.querySelector('#t-first-time').textContent = fmtTime(stats.first.t)
      this.root.querySelector('#t-first-dist').textContent = fmtDist(stats.first.dist)
    }
    if (stats.last) {
      this.root.querySelector('#t-last-time').textContent = fmtTime(stats.last.t)
      this.root.querySelector('#t-last-dist').textContent = fmtDist(stats.last.dist)
    }
  }

  // ── Se llama cuando todos llegaron o el usuario detiene la simulación ──
  finalize() {
    if (this.finalized) return
    this.finalized = true
    this._refreshLiveKpis()
    this.toggle(true)
    this.root.querySelector('#dash-title').textContent = '📊 Resumen final de la simulación'
    this.root.querySelector('#dash-finish').style.display = 'none'
    const stats = computeArrivalStats(this.as, this.optimalMeters)
    kafkaFinalizeLog(stats)
  }

  dispose() {
    ;[this.chartRecalc, this.chartIncType, this.chartZonesTime, this.chartIncTime, this.chartSpeedTime].forEach(c => c?.destroy())
    this.root.remove()
  }
}

// Deja un resumen legible en consola además del dashboard visual (útil para depurar/demo)
function kafkaFinalizeLog(stats) {
  console.info('[Analítica] Resumen final:', {
    llegaron: `${stats.n}/${stats.total}`,
    tiempo_promedio_s: stats.meanT?.toFixed(1),
    desviacion_estandar_s: stats.stdDev?.toFixed(1),
    distancia_promedio_m: stats.avgDist?.toFixed(0),
    score_eficiencia: stats.efficiency?.toFixed(2),
  })
}

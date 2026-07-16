import { navigate } from '../router.js'
import { session } from '../net/session.js'
import { createOnlineWorld, OWNER_COLORS } from './onlineWorld.js'
import { CHAT_PANEL_HTML, wireChatPanel } from './chatPanel.js'
import { wireCopyButton } from '../ui/clipboard.js'
import { wireCollapseToggle } from '../ui/collapse.js'
import { memberRow } from '../ui/memberRow.js'

// ════════════════════════════════════════════════════════════════
//  VISTA ADMIN (M3) — mundo completo en 3D (con toggle a 2D).
//  Controla la FRECUENCIA DE INCIDENTES (lo aleatorio que él analiza)
//  y el ciclo de la sala: iniciar / pausar / reiniciar. Ve el resumen
//  de la flota de cada usuario en su color.
// ════════════════════════════════════════════════════════════════
export function renderAdminView(app) {
  // Sin sala activa (URL directa o sesión caída) → al lobby
  if (session.role !== 'admin' || !session.code) { navigate('/lobby'); return }

  const view = document.createElement('div')
  view.className = 'view-sim'
  view.innerHTML = `
    <canvas id="sim-canvas"></canvas>
    <div class="sim-topbar">
      <div class="panel sim-metrics">
        <div class="sim-metrics-head">
          <h3>Panel de control</h3>
          <button id="metrics-toggle" class="metrics-toggle" title="Colapsar / expandir el panel (despeja el mapa)">▾</button>
        </div>
        <div class="sim-metrics-body">
          <h3>En la sala</h3>
          <div id="r-members" class="hud-members">—</div>
          <div class="room-code-row">
            <b class="room-code">${session.code}</b>
            <button id="btn-copy-code" class="btn-copy-code" title="Copiar código de sala">📋</button>
          </div>
          <div class="row" style="margin-top:10px"><span class="k">Estado</span><span class="v" id="r-running">—</span></div>
          <div class="slider-row" style="margin-top:10px">
            <div class="head"><span>Frecuencia de incidentes</span><b id="lbl-freq">cada ~10s</b></div>
            <input type="range" id="sl-freq" min="3" max="60" value="10" />
          </div>
          <div class="admin-controls">
            <button class="btn secondary" id="btn-start">▶️ Iniciar</button>
            <button class="btn secondary" id="btn-pause">⏸️ Pausar</button>
            <button class="btn secondary" id="btn-reset">🔄 Reiniciar</button>
          </div>
          <h3 style="margin-top:10px">Flotas de la sala</h3>
          <div id="r-fleets" class="hud-members">— sin flotas configuradas —</div>
          <div id="r-alerts" class="admin-alerts"></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
        <button class="btn secondary" id="btn-leave">← Salir de la sala</button>
        <div class="cam-toggle panel" style="padding:6px">
          <button id="btn-cam-2d">🗺️ 2D</button>
          <button id="btn-cam-3d" class="active">🧭 3D</button>
        </div>
      </div>
    </div>
    ${CHAT_PANEL_HTML}
    <button id="dash-toggle" class="btn secondary dash-fab">📊 Analítica global</button>
    <div id="dash-panel" class="panel dash-panel hidden">
      <div class="dash-head">
        <h3>📊 Detección del pipeline · Big Data</h3>
        <button id="dash-close" class="btn secondary" style="padding:6px 10px;font-size:12px">✕</button>
      </div>
      <div class="dash-kpis">
        <div class="kpi-tile"><div class="kpi-val" id="d-red">0</div><div class="kpi-lbl">Zonas rojas (Spark)</div></div>
        <div class="kpi-tile"><div class="kpi-val" id="d-detected">0</div><div class="kpi-lbl">Bloqueos detectados</div></div>
        <div class="kpi-tile"><div class="kpi-val" id="d-lastdet">—</div><div class="kpi-lbl">Última detección</div></div>
        <div class="kpi-tile"><div class="kpi-val" id="d-active">0</div><div class="kpi-lbl">Activos</div></div>
        <div class="kpi-tile"><div class="kpi-val" id="d-arrived">0</div><div class="kpi-lbl">Llegados</div></div>
        <div class="kpi-tile"><div class="kpi-val" id="d-inc">0</div><div class="kpi-lbl">Incidentes act.</div></div>
      </div>
      <div class="dash-grid" style="grid-template-columns: 1.4fr 1fr">
        <div class="dash-card">
          <h4>Desglose por usuario</h4>
          <table class="dash-table" id="d-users">
            <tr>
              <th>U</th>
              <th>Llegados</th>
              <th title="Tiempo medio de viaje de la flota que llegó, en segundos">Viaje medio (s)</th>
              <th title="Eficiencia de ruta = distancia óptima ÷ distancia realmente recorrida. 1.00 = viajó por la ruta ideal; menos = dio vueltas por atascos o reruteos">Eficiencia</th>
              <th title="Veces que la flota fue reruteada para esquivar una zona roja de Spark">Rerutas</th>
            </tr>
          </table>
          <div id="d-rank" style="font-size:11px;color:var(--text-dim);margin-top:6px">—</div>
        </div>
        <div class="dash-card">
          <h4>Mapa de calor de zonas · <span id="d-critical" style="text-transform:none">—</span></h4>
          <canvas id="d-heatmap" class="dash-heatmap"></canvas>
          <h4 style="margin-top:8px">Zonas rojas detectadas por Spark (en el tiempo)</h4>
          <canvas id="d-spark" style="width:100%;height:56px"></canvas>
        </div>
      </div>
    </div>
  `
  app.appendChild(view)

  const world = createOnlineWorld(view.querySelector('#sim-canvas'), {
    initialMode: '3d',
    onHud: h => {
      view.querySelector('#r-running').textContent = h.running ? '▶️ corriendo' : '⏸️ pausada'
    },
  })

  const btn2d = view.querySelector('#btn-cam-2d')
  const btn3d = view.querySelector('#btn-cam-3d')
  function setMode(m) {
    world.setMode(m)
    btn2d.classList.toggle('active', m === '2d')
    btn3d.classList.toggle('active', m === '3d')
  }
  btn2d.addEventListener('click', () => setMode('2d'))
  btn3d.addEventListener('click', () => setMode('3d'))
  wireCopyButton(view.querySelector('#btn-copy-code'), () => session.code)
  view.querySelector('#btn-leave').addEventListener('click', () => { session.leave(); navigate('/lobby') })

  // ── Controles del admin → mensajes al servidor ──
  const slFreq = view.querySelector('#sl-freq')
  slFreq.addEventListener('input', () => { view.querySelector('#lbl-freq').textContent = `cada ~${slFreq.value}s` })
  slFreq.addEventListener('change', () => session.socket.send({ type: 'admin_set_incidents', freq: +slFreq.value }))
  view.querySelector('#btn-start').addEventListener('click', () => session.socket.send({ type: 'admin_control', action: 'start' }))
  view.querySelector('#btn-pause').addEventListener('click', () => session.socket.send({ type: 'admin_control', action: 'pause' }))
  view.querySelector('#btn-reset').addEventListener('click', () => session.socket.send({ type: 'admin_control', action: 'reset' }))

  // Colapsar el panel de métricas: se ubica arriba-IZQUIERDA, justo donde se
  // arman las colas (cerca de los spawns), así que tapa las zonas rojas que el
  // admin está mostrando. Colapsado deja solo la barra del título → mapa libre.
  wireCollapseToggle(view.querySelector('.sim-metrics'), view.querySelector('#metrics-toggle'))

  // ── Estado que llega del servidor ──
  function showSimInfo(m) {
    world.applySimInfo(m)
    slFreq.value = m.incidentFreq
    view.querySelector('#lbl-freq').textContent = `cada ~${m.incidentFreq}s`
    if (!m.fleets.length) {
      view.querySelector('#r-fleets').textContent = '— sin flotas configuradas —'
    } else {
      view.querySelector('#r-fleets').innerHTML = m.fleets.map(f => {
        const color = OWNER_COLORS[f.slot] ?? '#94a3b8'
        const route = f.origin && f.dest ? `${f.origin} → ${f.dest}` : 'sin ruta'
        const status = f.invoked ? `${f.spawned}/${f.count} · llegaron ${f.arrived}` : 'sin invocar'
        const pers = f.personal.active ? '🚗 en vía' : f.personal.arrived > 0 ? '🚗 llegó' : '🚗 —'
        return `<span style="color:${color}">■</span> U${f.slot}: ${route} · ${status} · ${pers}`
      }).join('<br>')
      // si el personal de un usuario alertado ya está activo, retirar su alerta
      for (const f of m.fleets) if (f.personal.active) view.querySelector(`#alert-u${f.slot}`)?.remove()
    }
  }

  // Alerta del servidor: un usuario configuró ruta pero no ha invocado su vehículo.
  // El admin puede invocarlo por él ("para que el metaverso lo capte").
  function showAlert(m) {
    if (m.alert !== 'vehicle_not_invoked') return
    const alerts = view.querySelector('#r-alerts')
    if (view.querySelector(`#alert-u${m.userId}`)) return   // ya visible
    const div = document.createElement('div')
    div.id = `alert-u${m.userId}`
    div.className = 'admin-alert'
    div.innerHTML = `⚠️ Usuario ${m.userId} no ha invocado su vehículo
      <button class="btn" data-slot="${m.userId}">🚗 Invocar por él</button>`
    div.querySelector('button').addEventListener('click', () => {
      session.socket.send({ type: 'admin_invoke_user', userId: m.userId })
      div.remove()
    })
    alerts.appendChild(div)
  }
  // ── En la sala ──
  // Misma lista que en la vista del usuario y con el mismo constructor: el punto
  // de color ya dice qué slot es cada quien, así que la fila lleva el nombre.
  // Aquí el espectador es el admin, y su fila (punto y etiqueta "tú") va en oro
  // —el mismo --amber del anuncio y del antiguo chip 👑 ADMIN—, no en un color
  // de flota: el admin no tiene flota.
  function showMembers(rs) {
    view.querySelector('#r-members').replaceChildren(
      memberRow('👑', 'var(--amber)', rs.admin ?? session.name, true),
      ...rs.users.map(u => memberRow('■', OWNER_COLORS[u.slot] ?? '#94a3b8', u.name, false)),
    )
  }

  // ── Dashboard global (M5): admin_analytics llega cada ~1s del consumidor Kafka ──
  const dashPanel = view.querySelector('#dash-panel')
  view.querySelector('#dash-toggle').addEventListener('click', () => dashPanel.classList.toggle('hidden'))
  view.querySelector('#dash-close').addEventListener('click', () => dashPanel.classList.add('hidden'))

  function drawHeatmap(zones, redFlags) {
    const canvas = view.querySelector('#d-heatmap')
    const ctx = canvas.getContext('2d')
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    const cols = zones.cols, rows = zones.rows, cw = w / cols, ch = h / rows
    for (let i = 0; i < zones.C.length; i++) {
      const t = Math.min(1, zones.C[i])
      const r = Math.round(42 + t * 206), gg = Math.round(58 + t * 55), b = Math.round(79 + t * 34)
      ctx.fillStyle = `rgb(${r},${gg},${b})`
      const x = (i % cols) * cw, y = Math.floor(i / cols) * ch
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2)
      // Borde rojo desde el detector Spark (redFlags), NO desde el ZoneSystem interno.
      if (redFlags[i]) { ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2) }
    }
  }
  function drawSpark(series) {
    const canvas = view.querySelector('#d-spark')
    const ctx = canvas.getContext('2d')
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h || !series.t.length) return
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    ctx.clearRect(0, 0, w, h)
    const line = (data, color, maxV) => {
      const max = Math.max(maxV, ...data)
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath()
      data.forEach((v, i) => {
        const x = (i / Math.max(1, data.length - 1)) * w
        const y = h - (v / max) * (h - 4) - 2
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
    line(series.red, '#f87171', 6)
  }

  function showAnalytics(m) {
    // Zonas rojas del detector Spark (índices de celda activos). El overlay de los
    // jugadores se pinta de esta misma fuente, así que el KPI nunca puede
    // contradecir lo que se ve en pantalla. Es la salida VIVA del pipeline: el
    // metaverso no la calcula, la recibe.
    const sparkRed = m.sparkRedZones ?? []
    view.querySelector('#d-red').textContent = sparkRed.length
    // Actividad acumulada del detector en la corrida (redPoints.detectionStatsFor).
    const det = m.detection ?? { total: 0, lastAgoMs: null }
    view.querySelector('#d-detected').textContent = det.total
    view.querySelector('#d-lastdet').textContent =
      det.lastAgoMs == null ? '—' : `hace ${Math.round(det.lastAgoMs / 1000)}s`
    view.querySelector('#d-active').textContent = m.global.active
    view.querySelector('#d-arrived').textContent = m.global.arrived
    view.querySelector('#d-inc').textContent = m.global.incidentsActive

    const table = view.querySelector('#d-users')
    table.querySelectorAll('tr:not(:first-child)').forEach(tr => tr.remove())
    for (const p of m.perUser) {
      const tr = document.createElement('tr')
      const trophies = [
        m.rankings.fastestFleet === p.slot ? '🥇' : '',
        m.rankings.slowestFleet === p.slot ? '🐢' : '',
      ].join('')
      tr.innerHTML = `
        <td style="color:${OWNER_COLORS[p.slot] ?? '#94a3b8'}">■ U${p.slot} ${trophies}</td>
        <td>${p.fleet.arrived}/${p.fleet.spawned}</td>
        <td>${p.fleet.avgTravel_s ?? '—'}</td>
        <td>${p.efficiency != null ? p.efficiency.toFixed(2) : '—'}</td>
        <td>${p.reroutes}</td>`
      table.appendChild(tr)
    }
    view.querySelector('#d-rank').textContent =
      'Viaje medio: tiempo puerta a puerta · Eficiencia = óptima ÷ recorrida (1.00 = ruta ideal) · 🥇 más rápida · 🐢 más lenta'
    view.querySelector('#d-critical').textContent = m.critical
      ? `foco: ${m.critical.label}` : 'foco: —'
    // Bordes rojos del heatmap desde las zonas rojas de Spark (no las del ZoneSystem).
    const redFlags = new Array(m.zones.C.length).fill(0)
    for (const z of sparkRed) if (z >= 0 && z < redFlags.length) redFlags[z] = 1
    drawHeatmap(m.zones, redFlags)
    drawSpark(m.series)
  }

  if (session.simInfo) showSimInfo(session.simInfo)
  if (session.roomState) showMembers(session.roomState)

  const subs = [
    session.on('world_snapshot', m => world.pushSnapshot(m)),
    session.on('sim_info', showSimInfo),
    session.on('room_state', showMembers),
    session.on('alert_admin', showAlert),
    session.on('admin_analytics', showAnalytics),
    wireChatPanel(view, world),
  ]

  window.__teardownView = () => {
    subs.forEach(off => off())
    world.dispose()
  }
}

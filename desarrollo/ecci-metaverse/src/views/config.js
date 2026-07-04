import { navigate } from '../router.js'
import { store } from '../state/store.js'
import { CALLES, CARRERAS, DIAGONALS, POINTS, NODES, MAP_BOUNDS } from '../graph/mapData.js'

// ════════════════════════════════════════════════════════════════
//  VISTA 2 — CONFIGURACIÓN: elegir origen/destino (15 puntos fijos)
//  sobre un mini-mapa 2D, y ajustar avatares/incidentes con sliders.
// ════════════════════════════════════════════════════════════════
const PAD = 26   // margen en px alrededor del trazado dentro del canvas

export function renderConfig(app) {
  const view = document.createElement('div')
  view.className = 'view-config'
  view.innerHTML = `
    <div class="topbar">
      <h2>⚙️ Configuración de la simulación</h2>
      <button class="btn secondary" id="btn-volver">← Portada</button>
    </div>
    <div class="config-grid">
      <canvas id="minimap-canvas"></canvas>
      <div class="config-side">
        <div class="panel">
          <h3>Origen / Destino</h3>
          <p style="font-size:12px;color:var(--text-dim);margin-bottom:10px">
            Haz clic en dos de los 15 puntos numerados del mapa.
          </p>
          <div class="od-pill">
            <div class="box origin"><div class="lbl">Origen</div><div class="val" id="val-origin">— sin elegir —</div></div>
            <div class="box dest"><div class="lbl">Destino</div><div class="val" id="val-dest">— sin elegir —</div></div>
          </div>
        </div>
        <div class="panel">
          <h3>Simulación</h3>
          <div class="slider-row">
            <div class="head"><span>Cantidad de avatares</span><b id="lbl-avatars">${store.numAvatars}</b></div>
            <input type="range" id="sl-avatars" min="1" max="500" value="${store.numAvatars}" />
          </div>
          <div class="slider-row" style="margin-top:14px">
            <div class="head"><span>Frecuencia de incidentes</span><b id="lbl-freq">cada ${store.incidentFreq}s</b></div>
            <input type="range" id="sl-freq" min="3" max="60" value="${store.incidentFreq}" />
          </div>
          <div class="slider-row" style="margin-top:14px">
            <div class="head"><span>Detección de zonas rojas</span></div>
            <select id="sel-detection" style="width:100%;margin-top:6px">
              <option value="local">Local (en el navegador)</option>
              <option value="pipeline">Pipeline (Spark vía bridge)</option>
            </select>
          </div>
        </div>
        <button class="btn" id="btn-start" disabled>Iniciar simulación</button>
      </div>
    </div>
  `
  app.appendChild(view)

  // ── Referencias UI ──
  const canvas = view.querySelector('#minimap-canvas')
  const ctx = canvas.getContext('2d')
  const valOrigin = view.querySelector('#val-origin')
  const valDest = view.querySelector('#val-dest')
  const btnStart = view.querySelector('#btn-start')
  const slAvatars = view.querySelector('#sl-avatars')
  const lblAvatars = view.querySelector('#lbl-avatars')
  const slFreq = view.querySelector('#sl-freq')
  const lblFreq = view.querySelector('#lbl-freq')

  view.querySelector('#btn-volver').addEventListener('click', () => navigate('#/'))

  // ── Transform: coordenadas de mundo (x,z) → píxeles del canvas ──
  const { xMin, xMax, zMin, zMax } = MAP_BOUNDS
  function toPx(x, z) {
    const w = canvas.width - PAD * 2, h = canvas.height - PAD * 2
    return {
      px: PAD + ((x - xMin) / (xMax - xMin)) * w,
      py: PAD + ((z - zMin) / (zMax - zMin)) * h,   // z crece hacia el sur → abajo en pantalla
    }
  }

  function pointScreenPos(p) {
    const n = NODES[p.node]
    return toPx(n.x, n.z)
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#0d1520'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Carreras (verticales)
    CARRERAS.forEach(cr => {
      const a = toPx(cr.x, CALLES[0].z), b = toPx(cr.x, CALLES[CALLES.length - 1].z)
      ctx.strokeStyle = cr.avenida ? '#4a5a70' : '#2a3340'
      ctx.lineWidth = cr.avenida ? 3 : 1.4
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke()
    })
    // Calles (horizontales)
    CALLES.forEach(cl => {
      const a = toPx(CARRERAS[0].x, cl.z), b = toPx(CARRERAS[CARRERAS.length - 1].x, cl.z)
      ctx.strokeStyle = cl.avenida ? '#4a5a70' : '#2a3340'
      ctx.lineWidth = cl.avenida ? 3 : 1.4
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke()
    })
    // Diagonales / transversales (amarillas, según el esquema original)
    ctx.strokeStyle = 'rgba(251,191,36,0.55)'; ctx.lineWidth = 1.6
    DIAGONALS.forEach(d => {
      const na = NODES[d.a], nb = NODES[d.b]
      const a = toPx(na.x, na.z), b = toPx(nb.x, nb.z)
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke()
    })

    // 15 puntos numerados
    POINTS.forEach((p, i) => {
      const { px, py } = pointScreenPos(p)
      const isOrigin = store.originId === p.id
      const isDest = store.destId === p.id
      ctx.beginPath(); ctx.arc(px, py, isOrigin || isDest ? 10 : 7, 0, Math.PI * 2)
      ctx.fillStyle = isOrigin ? '#34d399' : isDest ? '#f87171' : '#3b82f6'
      ctx.fill()
      ctx.strokeStyle = '#0d1520'; ctx.lineWidth = 2; ctx.stroke()
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), px, py + 1)
    })
  }

  function pointAt(px, py) {
    for (const p of POINTS) {
      const pos = pointScreenPos(p)
      if (Math.hypot(pos.px - px, pos.py - py) < 14) return p
    }
    return null
  }

  function updateSelectionLabels() {
    const oP = POINTS.find(p => p.id === store.originId)
    const dP = POINTS.find(p => p.id === store.destId)
    valOrigin.textContent = oP ? `${oP.id} · ${oP.name}` : '— sin elegir —'
    valDest.textContent = dP ? `${dP.id} · ${dP.name}` : '— sin elegir —'
    btnStart.disabled = !(store.originId && store.destId && store.originId !== store.destId)
  }

  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    const p = pointAt(px, py)
    if (!p) return
    if (store.originId === null) store.originId = p.id
    else if (p.id === store.originId) store.originId = null
    else if (store.destId === null) store.destId = p.id
    else if (p.id === store.destId) store.destId = null
    else store.destId = p.id   // reemplaza el destino previo
    updateSelectionLabels()
    draw()
  })

  slAvatars.addEventListener('input', () => {
    store.numAvatars = +slAvatars.value
    lblAvatars.textContent = store.numAvatars
  })
  slFreq.addEventListener('input', () => {
    store.incidentFreq = +slFreq.value
    lblFreq.textContent = `cada ${store.incidentFreq}s`
  })

  const selDetection = view.querySelector('#sel-detection')
  selDetection.value = store.detectionMode
  selDetection.addEventListener('change', () => {
    store.detectionMode = selDetection.value
  })

  btnStart.addEventListener('click', () => {
    if (btnStart.disabled) return
    navigate('#/simulacion')
  })

  const resizeObserver = new ResizeObserver(() => draw())
  resizeObserver.observe(canvas)
  updateSelectionLabels()
  draw()

  window.__teardownView = () => resizeObserver.disconnect()
}

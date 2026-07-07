import { navigate } from '../router.js'
import { session } from '../net/session.js'
import { createOnlineWorld, OWNER_COLORS } from './onlineWorld.js'
import { buildOptions } from './config.js'

// ════════════════════════════════════════════════════════════════
//  VISTA USUARIO (M3) — SOLO 2D cenital. El usuario controla SU flota:
//  origen/destino (15 puntos), cantidad, oleadas, e "Invocar vehículos".
//  Sus vehículos se resaltan (más grandes y a todo color); las flotas
//  de los demás se ven atenuadas. Los incidentes los pone el admin.
// ════════════════════════════════════════════════════════════════
export function renderUserView(app) {
  // Sin sala activa (URL directa o sesión caída) → al lobby
  if (session.role !== 'user' || !session.code) { navigate('#/lobby'); return }

  const myColor = OWNER_COLORS[session.slot] ?? '#94a3b8'
  const view = document.createElement('div')
  view.className = 'view-sim'
  view.innerHTML = `
    <canvas id="sim-canvas"></canvas>
    <div class="room-code-banner panel">
      <span class="role-badge user" style="border-color:${myColor};color:${myColor}">🚗 USUARIO ${session.slot}</span>
      <span>Sala <b class="room-code">${session.code}</b></span>
      <span id="r-status">🟡</span>
    </div>
    <div class="sim-topbar">
      <div class="panel sim-metrics user-controls">
        <h3>🚗 Mi flota · ${session.name}</h3>
        <div class="od-selects" style="margin-top:6px">
          <label>Origen<select id="sel-origin">${buildOptions(null)}</select></label>
          <label>Destino<select id="sel-dest">${buildOptions(null)}</select></label>
        </div>
        <div class="slider-row" style="margin-top:10px">
          <div class="head"><span>Vehículos</span><b id="lbl-count">20</b></div>
          <input type="range" id="sl-count" min="1" max="150" value="20" />
        </div>
        <div class="slider-row" style="margin-top:8px">
          <div class="head"><span>Salida</span><b id="lbl-spawn">5 cada 2s</b></div>
          <div class="spawn-pair">
            <div><div class="mini-lbl">Por oleada</div><input type="range" id="sl-batch" min="1" max="20" value="5" /></div>
            <div><div class="mini-lbl">Segundos</div><input type="range" id="sl-every" min="0.5" max="10" step="0.5" value="2" /></div>
          </div>
        </div>
        <button class="btn" id="btn-personal" disabled style="margin-top:12px">🚗 Invocar MI vehículo</button>
        <button class="btn secondary" id="btn-fleet" disabled style="margin-top:6px">🚚 Invocar flota</button>
        <div class="row" style="margin-top:10px"><span class="k">Mi vehículo</span><span class="v" id="r-personal">— sin invocar —</span></div>
        <div class="row"><span class="k">Mi flota (salieron / llegaron)</span><span class="v" id="r-mine" style="color:${myColor}">0 / 0</span></div>
        <div class="row"><span class="k">Mundo (todos)</span><span class="v" id="r-counts">0 / 0</span></div>
        <div class="row"><span class="k">Estado</span><span class="v" id="r-running">—</span></div>
        <h3 style="margin-top:10px">📊 Mi analítica (BigData)</h3>
        <div class="row"><span class="k">Tiempo prom. de mi flota</span><span class="v" id="a-avg">—</span></div>
        <div class="row"><span class="k">Mi vehículo (viajes · t̄)</span><span class="v" id="a-pers">—</span></div>
        <div class="row"><span class="k">Decisiones (seguir/alterna/⏱)</span><span class="v" id="a-dec">0 / 0 / 0</span></div>
        <div class="row"><span class="k">Ahorro por alternativas</span><span class="v" id="a-save">0s</span></div>
        <div class="row"><span class="k">Score de eficiencia E</span><span class="v" id="a-eff">—</span></div>
        <div class="row"><span class="k">Recálculos sufridos</span><span class="v" id="a-rer">0</span></div>
        <h3 style="margin-top:10px">En la sala</h3>
        <div id="r-members" class="hud-members">—</div>
      </div>
      <button class="btn secondary" id="btn-leave">← Salir de la sala</button>
    </div>
    <div id="decision-card" class="decision-card panel hidden">
      <h3>⚠️ Atasco en tu ruta — decide en <span id="dc-secs">5.0</span>s</h3>
      <div class="dc-bar"><div id="dc-fill"></div></div>
      <div class="dc-buttons">
        <button class="btn secondary" id="dc-keep">🛑 Seguir mi ruta<br><small id="dc-eta-keep">—</small></button>
        <button class="btn" id="dc-alt">🔀 Tomar alternativa<br><small id="dc-eta-alt">—</small></button>
      </div>
    </div>
    <div id="dc-note" class="dc-note hidden"></div>
  `
  app.appendChild(view)

  // Vista 2D fija; la flota propia (owner = mi slot) se dibuja resaltada
  const world = createOnlineWorld(view.querySelector('#sim-canvas'), {
    initialMode: '2d',
    highlightOwner: session.slot,
    onHud: h => {
      view.querySelector('#r-counts').textContent = `${h.spawned} / ${h.arrived}`
      view.querySelector('#r-running').textContent = h.running ? '▶️ corriendo' : '⏸️ pausada por el admin'
    },
  })

  view.querySelector('#btn-leave').addEventListener('click', () => { session.leave(); navigate('#/lobby') })

  // ── Controles de flota → mensajes al servidor ──
  const selOrigin = view.querySelector('#sel-origin')
  const selDest = view.querySelector('#sel-dest')
  const slCount = view.querySelector('#sl-count')
  const slBatch = view.querySelector('#sl-batch')
  const slEvery = view.querySelector('#sl-every')
  const btnPersonal = view.querySelector('#btn-personal')
  const btnFleet = view.querySelector('#btn-fleet')

  function sendRoute() {
    if (!selOrigin.value || !selDest.value || selOrigin.value === selDest.value) return
    session.socket.send({ type: 'set_route', userId: session.slot, origin: selOrigin.value, dest: selDest.value })
    sendFleet()   // la flota se crea con la ruta: aplicar también los sliders actuales
  }
  function sendFleet() {
    session.socket.send({
      type: 'set_fleet', userId: session.slot,
      count: +slCount.value, spawnBatch: +slBatch.value, spawnEvery: +slEvery.value,
    })
  }
  selOrigin.addEventListener('change', sendRoute)
  selDest.addEventListener('change', sendRoute)
  slCount.addEventListener('input', () => { view.querySelector('#lbl-count').textContent = slCount.value })
  slBatch.addEventListener('input', updateSpawnLbl)
  slEvery.addEventListener('input', updateSpawnLbl)
  slCount.addEventListener('change', sendFleet)
  slBatch.addEventListener('change', sendFleet)
  slEvery.addEventListener('change', sendFleet)
  function updateSpawnLbl() { view.querySelector('#lbl-spawn').textContent = `${slBatch.value} cada ${slEvery.value}s` }

  // invoke_vehicle = MI vehículo personal (el de la decisión de 5s); invoke_fleet = la flota
  btnPersonal.addEventListener('click', () => session.socket.send({ type: 'invoke_vehicle', userId: session.slot }))
  btnFleet.addEventListener('click', () => {
    session.socket.send({ type: 'invoke_fleet', userId: session.slot })
    btnFleet.textContent = '🚚 Invocar más flota'
  })

  // ── Tarjeta de decisión (route_offer → 5 segundos → route_decision) ──
  const card = view.querySelector('#decision-card')
  const note = view.querySelector('#dc-note')
  let currentOffer = null
  let cdTimer = null
  let noteTimer = null
  const fmtEta = s => s >= 90 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `~${Math.round(s)}s`

  function showNote(text) {
    note.textContent = text
    note.classList.remove('hidden')
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => note.classList.add('hidden'), 3500)
  }
  function hideCard() {
    card.classList.add('hidden')
    clearInterval(cdTimer)
    cdTimer = null
    currentOffer = null
  }
  function showOffer(m) {
    currentOffer = m
    view.querySelector('#dc-eta-keep').textContent = `atasco · ETA ${fmtEta(m.currentEta)}`
    view.querySelector('#dc-eta-alt').textContent = `ETA ${fmtEta(m.altEta)}`
    card.classList.remove('hidden')
    clearInterval(cdTimer)
    cdTimer = setInterval(() => {
      const left = m.deadline - Date.now()
      if (left <= 0) {   // sin respuesta: el servidor aplica 'keep' por defecto
        hideCard()
        showNote('⏱️ Sin respuesta: sigues tu ruta (esperando el atasco)')
        return
      }
      view.querySelector('#dc-secs').textContent = (left / 1000).toFixed(1)
      view.querySelector('#dc-fill').style.width = `${(left / 5000) * 100}%`
    }, 100)
  }
  function decide(choice) {
    if (!currentOffer) return
    session.socket.send({ type: 'route_decision', userId: session.slot, vehicleId: currentOffer.vehicleId, choice })
    hideCard()
    showNote(choice === 'alternative' ? '🔀 Tomando la ruta alternativa' : '🛑 Sigues tu ruta original')
  }
  view.querySelector('#dc-keep').addEventListener('click', () => decide('keep'))
  view.querySelector('#dc-alt').addEventListener('click', () => decide('alternative'))

  // ── Estado que llega del servidor ──
  function showSimInfo(m) {
    world.applySimInfo(m)
    const mine = m.fleets.find(f => f.slot === session.slot)
    if (mine) {
      view.querySelector('#r-mine').textContent = `${mine.spawned} / ${mine.arrived}`
      const p = mine.personal
      view.querySelector('#r-personal').textContent =
        p.active ? '🚗 en camino' : p.arrived > 0 ? `✅ llegó (${p.arrived} viajes)` : '— sin invocar —'
      btnPersonal.disabled = !(mine.origin && mine.dest) || p.active
      btnPersonal.textContent = p.active ? '🚗 Mi vehículo va en camino' : '🚗 Invocar MI vehículo'
      // sincronizar controles si el server ya tenía config (reconexión / otra pestaña)
      if (mine.origin && !selOrigin.value) selOrigin.value = mine.origin
      if (mine.dest && !selDest.value) selDest.value = mine.dest
    }
    btnFleet.disabled = !(mine && mine.origin && mine.dest)
  }
  // Conteo en vivo de MI flota a partir del snapshot (stride 6: owner en la posición 5)
  function countMine(m) {
    let spawned = 0, arrived = 0
    for (let k = 0; k < m.a.length; k += 6) {
      if (m.a[k + 5] !== session.slot) continue
      spawned++
      if (m.a[k + 4] === 3 /* ARRIVED */) arrived++
    }
    view.querySelector('#r-mine').textContent = `${spawned} / ${arrived}`
  }
  function showMembers(rs) {
    const lines = [rs.adminReady ? `👑 ${rs.admin}` : '👑 (admin desconectado)']
    for (const u of rs.users) {
      const color = OWNER_COLORS[u.slot] ?? '#94a3b8'
      const me = u.slot === session.slot ? ' ← tú' : ''
      lines.push(`<span style="color:${color}">■</span> Usuario ${u.slot} · ${u.name}${me}`)
    }
    view.querySelector('#r-members').innerHTML = lines.join('<br>')
  }

  // Analítica personal (M5): la agrega el consumidor Kafka y llega cada ~1s
  function showMyAnalytics({ metrics: a }) {
    view.querySelector('#a-avg').textContent = a.fleet.avgTravel_s != null ? `${a.fleet.avgTravel_s}s` : '—'
    view.querySelector('#a-pers').textContent = a.personal.trips
      ? `${a.personal.trips} · ${a.personal.avgTravel_s}s` : '—'
    view.querySelector('#a-dec').textContent = `${a.decisions.keep} / ${a.decisions.alternative} / ${a.decisions.timeout}`
    view.querySelector('#a-save').textContent = `${a.savings_s}s`
    view.querySelector('#a-eff').textContent = a.efficiency != null ? a.efficiency.toFixed(2) : '—'
    view.querySelector('#a-rer').textContent = a.reroutes
  }

  if (session.simInfo) showSimInfo(session.simInfo)
  if (session.roomState) showMembers(session.roomState)

  const subs = [
    session.on('world_snapshot', m => { world.pushSnapshot(m); countMine(m) }),
    session.on('sim_info', showSimInfo),
    session.on('room_state', showMembers),
    session.on('route_offer', showOffer),
    session.on('your_analytics', showMyAnalytics),
    session.on('status', st => {
      view.querySelector('#r-status').textContent = st === 'open' ? '🟢' : st === 'connecting' ? '🟡' : '🔴'
    }),
  ]
  view.querySelector('#r-status').textContent = session.status === 'open' ? '🟢' : '🟡'

  window.__teardownView = () => {
    subs.forEach(off => off())
    clearInterval(cdTimer)
    clearTimeout(noteTimer)
    world.dispose()
  }
}

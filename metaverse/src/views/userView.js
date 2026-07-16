import { navigate } from '../router.js'
import { session } from '../net/session.js'
import { createOnlineWorld, OWNER_COLORS } from './onlineWorld.js'
import { buildOptions } from './config.js'
import { CHAT_PANEL_HTML, wireChatPanel } from './chatPanel.js'
import { wireCopyButton } from '../ui/clipboard.js'
import { wireCollapseToggle } from '../ui/collapse.js'
import { memberRow } from '../ui/memberRow.js'
import {
  fleetButtonDisabled, personalButtonDisabled, personalButtonLabel, routeSelectsDisabled,
} from './invokeLocks.js'

// ════════════════════════════════════════════════════════════════
//  VISTA USUARIO (M3) — SOLO 2D cenital. El usuario controla SU flota:
//  origen/destino (15 puntos), cantidad, oleadas, e "Invocar vehículos".
//  Sus vehículos se resaltan (más grandes y a todo color); las flotas
//  de los demás se ven atenuadas. Los incidentes los pone el admin.
// ════════════════════════════════════════════════════════════════
export function renderUserView(app) {
  // Sin sala activa (URL directa o sesión caída) → al lobby
  if (session.role !== 'user' || !session.code) { navigate('/lobby'); return }

  const view = document.createElement('div')
  view.className = 'view-sim view-sim-user'
  view.innerHTML = `
    <canvas id="sim-canvas"></canvas>
    <div class="sim-topbar">
      <div class="panel sim-metrics user-controls">
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
          <div class="od-selects" style="margin-top:10px">
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
        </div>
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
    ${CHAT_PANEL_HTML}
  `
  app.appendChild(view)

  // Vista 2D fija; la flota propia (owner = mi slot) se dibuja resaltada
  const world = createOnlineWorld(view.querySelector('#sim-canvas'), {
    initialMode: '2d',
    highlightOwner: session.slot,
    onHud: h => {
      view.querySelector('#r-running').textContent = h.running ? '▶️ corriendo' : '⏸️ pausada por el admin'
    },
  })

  view.querySelector('#btn-leave').addEventListener('click', () => { session.leave(); navigate('/lobby') })
  wireCopyButton(view.querySelector('#btn-copy-code'), () => session.code)
  // Mismo plegado que el panel del admin: el panel se para sobre el carril de
  // la izquierda, donde el detector marca las zonas rojas.
  wireCollapseToggle(view.querySelector('.sim-metrics'), view.querySelector('#metrics-toggle'))

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

  // Invocar congela los puntos: entre el clic y el sim_info de vuelta hay un
  // viaje de ida y vuelta, y un cambio de ruta colado ahí dejaría a los
  // vehículos rodando por la ruta vieja. Se bloquean de inmediato; el sim_info
  // confirma el bloqueo (o lo levanta, si el admin reinició la sala).
  function congelarPuntos() {
    selOrigin.disabled = true
    selDest.disabled = true
  }

  // invoke_vehicle = MI vehículo personal (el de la decisión de 5s); invoke_fleet = la flota
  btnPersonal.addEventListener('click', () => {
    session.socket.send({ type: 'invoke_vehicle', userId: session.slot })
    btnPersonal.disabled = true
    congelarPuntos()
  })
  // La flota se invoca una sola vez por corrida: se bloquea de inmediato para no
  // encolar otra tanda con doble clic.
  btnFleet.addEventListener('click', () => {
    session.socket.send({ type: 'invoke_fleet', userId: session.slot })
    btnFleet.disabled = true
    congelarPuntos()
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
      // El estado del vehículo personal lo carga el propio botón: sin fila que
      // lo repita, el rótulo es el que dice si va en camino o si ya llegó.
      btnPersonal.disabled = personalButtonDisabled(mine)
      btnPersonal.textContent = personalButtonLabel(mine)
      // sincronizar controles si el server ya tenía config (reconexión / otra pestaña)
      if (mine.origin && !selOrigin.value) selOrigin.value = mine.origin
      if (mine.dest && !selDest.value) selDest.value = mine.dest
    }
    // Los tres bloqueos los decide el servidor (fleets[].invoked y
    // fleets[].personal.invoked), que el reset del admin vuelve a false.
    // Ver invokeLocks.js.
    btnFleet.disabled = fleetButtonDisabled(mine)
    const puntosFijos = routeSelectsDisabled(mine)
    selOrigin.disabled = puntosFijos
    selDest.disabled = puntosFijos
  }
  // ── En la sala ──
  // El punto de color ya dice qué slot es cada quien: la fila lleva el nombre,
  // no el rótulo del slot (ver memberRow).
  function showMembers(rs) {
    view.querySelector('#r-members').replaceChildren(
      memberRow('👑', 'var(--amber)', rs.adminReady ? rs.admin : '(admin desconectado)', false),
      ...rs.users.map(u => memberRow(
        '■', OWNER_COLORS[u.slot] ?? '#94a3b8', u.name, u.slot === session.slot,
      )),
    )
  }

  if (session.simInfo) showSimInfo(session.simInfo)
  if (session.roomState) showMembers(session.roomState)

  const subs = [
    session.on('world_snapshot', m => world.pushSnapshot(m)),
    session.on('sim_info', showSimInfo),
    session.on('room_state', showMembers),
    session.on('route_offer', showOffer),
    wireChatPanel(view, world),
  ]

  window.__teardownView = () => {
    subs.forEach(off => off())
    clearInterval(cdTimer)
    clearTimeout(noteTimer)
    world.dispose()
  }
}

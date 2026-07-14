import { navigate } from '../router.js'
import { session } from '../net/session.js'

// ════════════════════════════════════════════════════════════════
//  LOBBY (M2) — puerta de entrada al modo multi-usuario:
//  · ADMIN: crea la sala → el servidor genera el código ECCI-XXXX.
//  · USUARIO: se une con el código que le compartió el admin.
//  Según el rol confirmado (room_joined), navega a #/admin o #/user.
// ════════════════════════════════════════════════════════════════
export function renderLobby(app) {
  const view = document.createElement('div')
  view.className = 'view-lobby'
  view.innerHTML = `
    <h1>🌐 Modo multi-usuario</h1>
    <p class="subtitle">1 administrador + hasta 3 usuarios comparten el mismo mundo en tiempo real.<br>
    El servidor debe estar corriendo: <code>make metaverse-server</code></p>
    <div class="lobby-grid">
      <div class="panel lobby-card">
        <h3>👑 Crear sala (Admin)</h3>
        <p>El servidor genera un código para compartir con los usuarios.</p>
        <input type="text" id="in-admin-name" placeholder="Tu nombre" maxlength="20" value="Admin" />
        <button class="btn" id="btn-create">Crear sala</button>
      </div>
      <div class="panel lobby-card">
        <h3>🚗 Unirse con código (Usuario)</h3>
        <p>Pide el código al admin (ej: ECCI-4821).</p>
        <input type="text" id="in-user-name" placeholder="Tu nombre" maxlength="20" />
        <input type="text" id="in-code" placeholder="ECCI-0000" maxlength="9" style="text-transform:uppercase" />
        <button class="btn" id="btn-join">Unirse</button>
      </div>
    </div>
    <div id="lobby-msg" class="lobby-msg"></div>
    <button class="btn secondary" id="btn-back">← Portada</button>
  `
  app.appendChild(view)

  const msg = view.querySelector('#lobby-msg')
  const btnCreate = view.querySelector('#btn-create')
  const btnJoin = view.querySelector('#btn-join')

  view.querySelector('#btn-back').addEventListener('click', () => { session.leave(); navigate('#/') })

  function setBusy(b, text = '') {
    btnCreate.disabled = b
    btnJoin.disabled = b
    msg.textContent = text
    msg.classList.remove('error')
  }

  btnCreate.addEventListener('click', () => {
    const name = view.querySelector('#in-admin-name').value.trim() || 'Admin'
    setBusy(true, 'Creando sala…')
    session.join({ role: 'admin', name })   // sin código = crear
  })

  btnJoin.addEventListener('click', () => {
    const name = view.querySelector('#in-user-name').value.trim() || 'Usuario'
    const code = view.querySelector('#in-code').value.trim().toUpperCase()
    if (!code) { msg.textContent = 'Escribe el código de la sala'; msg.classList.add('error'); return }
    setBusy(true, `Entrando a ${code}…`)
    session.join({ role: 'user', code, name })
  })

  // room_joined confirma rol y sala → ir a la vista correspondiente
  const offJoined = session.on('room_joined', m => {
    navigate(m.role === 'admin' ? '#/admin' : '#/user')
  })
  const offError = session.on('join_error', m => {
    setBusy(false)
    msg.textContent = `⚠️ ${m.reason}`
    msg.classList.add('error')
  })
  const offStatus = session.on('status', st => {
    if (st === 'closed') { setBusy(false); msg.textContent = '🔴 Sin conexión con el servidor (¿corre make metaverse-server?)'; msg.classList.add('error') }
  })

  window.__teardownView = () => { offJoined(); offError(); offStatus() }
}

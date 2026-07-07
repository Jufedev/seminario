// ════════════════════════════════════════════════════════════════
//  SESIÓN DE RED (M2) — UN solo socket para toda la app. El router
//  destruye vistas al navegar (lobby → admin/usuario) pero la sesión
//  y la sala sobreviven aquí. Si el socket se cae y reconecta, se
//  reenvía el join_room pendiente (re-entra a la misma sala).
// ════════════════════════════════════════════════════════════════
import { connectSocket, defaultServerUrl } from './socket.js'

const listeners = new Map()   // tipo de mensaje → Set<fn>

function emit(type, payload) {
  for (const fn of listeners.get(type) ?? []) fn(payload)
}

export const session = {
  socket: null,
  status: 'closed',    // 'connecting' | 'open' | 'closed'
  // identidad dentro de la sala (la confirma room_joined)
  code: null, role: null, slot: null, name: null,
  // últimos mensajes de estado (para vistas que montan después de recibirlos)
  roomState: null, simInfo: null,
  _pendingJoin: null,

  connect() {
    if (this.socket) return
    this.socket = connectSocket({
      url: defaultServerUrl(),
      onStatus: st => {
        this.status = st
        // reconexión: volver a entrar a la sala en la que estábamos
        if (st === 'open' && this._pendingJoin) this.socket.send(this._pendingJoin)
        emit('status', st)
      },
      onMessage: msg => {
        if (msg.type === 'room_joined') {
          this.code = msg.code; this.role = msg.role; this.slot = msg.slot; this.name = msg.name
        } else if (msg.type === 'room_state') this.roomState = msg
        else if (msg.type === 'sim_info') this.simInfo = msg
        emit(msg.type, msg)
      },
    })
  },

  // Entra (o crea, si es admin sin código) una sala. Se puede llamar antes de
  // que el socket abra: el onStatus('open') reenvía el join pendiente.
  join({ code, role, name }) {
    this.connect()
    this._pendingJoin = { type: 'join_room', code, role, name }
    this.socket.send(this._pendingJoin)
  },

  // Sale de la sala y cierra todo (botón "Salir" de las vistas)
  leave() {
    this.socket?.close()
    this.socket = null
    this.status = 'closed'
    this.code = this.role = this.slot = this.name = null
    this.roomState = this.simInfo = null
    this._pendingJoin = null
  },

  // Suscripción a mensajes; devuelve la función para desuscribirse (teardown de vistas)
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn)
    return () => listeners.get(type)?.delete(fn)
  },
}

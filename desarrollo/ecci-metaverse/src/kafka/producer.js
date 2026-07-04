// ════════════════════════════════════════════════════════════════
//  KAFKA PRODUCER — two modes:
//   'simulated' (default): console.debug only, app works standalone.
//   'live': WebSocket to the bridge backend (backend/bridge.py), which
//           forwards events to Kafka and pushes pipeline red points back.
//  Live mode activates when VITE_BRIDGE_WS_URL is set (see env.example).
// ════════════════════════════════════════════════════════════════
const MAX_LOG_EVENTS = 5000        // in-memory history cap (dashboard/debug input)
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000

class KafkaProducer {
  constructor() {
    this.ws = null
    this.sessionId = crypto.randomUUID()
    this.connected = false
    this.mode = 'simulated'   // 'simulated' | 'live'
    this.log = []             // in-memory history, input for the analytics dashboard
    this.dropped = 0          // events dropped while live but disconnected
    this.url = null
    this.listeners = new Set()
    this._reconnectMs = RECONNECT_BASE_MS
    this._reconnectTimer = null
    this._shouldReconnect = false
  }

  isLive() { return this.mode === 'live' }

  // Connect to the WebSocket bridge. Without a URL (env unset) stays simulated.
  connect(url = import.meta.env.VITE_BRIDGE_WS_URL) {
    if (!url) { console.info('[Kafka] Simulated mode — no bridge configured'); return }
    if (this.mode === 'live' && this.url === url) return   // already connected/connecting
    this.url = url
    this.mode = 'live'
    this._shouldReconnect = true
    this._open()
  }

  disconnect() {
    this._shouldReconnect = false
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null }
    this.connected = false
    this.mode = 'simulated'
    this.url = null
  }

  // Inbound messages from the bridge (e.g. pipeline red points).
  // Returns an unsubscribe function.
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _open() {
    this.ws = new WebSocket(this.url)
    this.ws.onopen = () => {
      this.connected = true
      this._reconnectMs = RECONNECT_BASE_MS
      console.info(`[Kafka] Connected to bridge ${this.url}`)
    }
    this.ws.onclose = () => {
      this.connected = false
      this._scheduleReconnect()
    }
    this.ws.onerror = () => { /* onclose follows and handles the retry */ }
    this.ws.onmessage = (e) => {
      let event
      try { event = JSON.parse(e.data) } catch { return }
      for (const fn of this.listeners) fn(event)
    }
  }

  // Simple exponential backoff; events are dropped (not queued) meanwhile.
  _scheduleReconnect() {
    if (!this._shouldReconnect || this._reconnectTimer) return
    console.warn(`[Kafka] Bridge disconnected — retrying in ${this._reconnectMs / 1000}s`)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._shouldReconnect) this._open()
    }, this._reconnectMs)
    this._reconnectMs = Math.min(this._reconnectMs * 2, RECONNECT_MAX_MS)
  }

  send(topic, payload) {
    const event = { topic, session_id: this.sessionId, ts: Date.now(), ...payload }
    this.log.push(event)
    if (this.log.length > MAX_LOG_EVENTS) this.log.splice(0, this.log.length - MAX_LOG_EVENTS)
    if (this.mode === 'simulated') {
      console.debug('[Kafka →]', topic, event)
      return
    }
    if (!this.connected) { this.dropped++; return }   // drop, never queue unbounded
    this.ws.send(JSON.stringify(event))
  }
}

export const kafka = new KafkaProducer()

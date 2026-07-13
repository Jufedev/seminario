// ════════════════════════════════════════════════════════════════
//  KAFKA PRODUCER (simulado) — hoy hace console.debug, mañana WebSocket→Kafka.
//  Todos los eventos del simulador (incidentes, recálculos, zonas rojas,
//  llegadas) pasan por acá para quedar listos para un backend real.
// ════════════════════════════════════════════════════════════════
// crypto.randomUUID() solo existe en contextos seguros (HTTPS o localhost).
// La demo se sirve por HTTP sobre IP pública, así que hace falta un respaldo.
// crypto.getRandomValues() sí está disponible en contextos inseguros.
function generarSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40   // versión 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80   // variante RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

class KafkaProducer {
  constructor() {
    this.ws = null
    this.sessionId = generarSessionId()
    this.connected = false
    this.mode = 'simulated'   // 'simulated' | 'live'
    this.log = []             // historial en memoria, insumo del dashboard de analítica
  }

  // Fase 2: connect(url) abrirá un WebSocket real hacia un gateway de Kafka
  connect(url = null) {
    if (!url) { console.info('[Kafka] Modo simulado — sin backend conectado'); return }
    this.ws = new WebSocket(url)
    this.ws.onopen = () => { this.connected = true; this.mode = 'live'; console.info('[Kafka] Conectado ✓') }
    this.ws.onclose = () => { this.connected = false; console.warn('[Kafka] Desconectado') }
  }

  send(topic, payload) {
    const event = { topic, session_id: this.sessionId, ts: Date.now(), ...payload }
    this.log.push(event)
    if (this.mode === 'simulated' || !this.connected) {
      console.debug('[Kafka →]', topic, event)
      return
    }
    this.ws.send(JSON.stringify(event))
  }

  // Envío por lote (mismo topic, N payloads). El servidor lo redirige a un solo
  // produce de Kafka vía attachEngine(); aquí (motor standalone) cae a send().
  sendBatch(topic, payloads) {
    for (const p of payloads) this.send(topic, p)
  }
}

export const kafka = new KafkaProducer()

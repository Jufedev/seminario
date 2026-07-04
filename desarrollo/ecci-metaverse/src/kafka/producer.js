// ════════════════════════════════════════════════════════════════
//  KAFKA PRODUCER (simulado) — hoy hace console.debug, mañana WebSocket→Kafka.
//  Todos los eventos del simulador (incidentes, recálculos, zonas rojas,
//  llegadas) pasan por acá para quedar listos para un backend real.
// ════════════════════════════════════════════════════════════════
class KafkaProducer {
  constructor() {
    this.ws = null
    this.sessionId = crypto.randomUUID()
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
}

export const kafka = new KafkaProducer()

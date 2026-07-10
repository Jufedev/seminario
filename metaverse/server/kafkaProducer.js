// ════════════════════════════════════════════════════════════════
//  PUENTE KAFKA (M5) — el servidor publica TODOS los eventos de la
//  simulación a topics de Kafka (room.lifecycle, agent.*, incident.*,
//  route.decision, zone.*, analytics.snapshot).
//
//  Modos (se decide al conectar, se ve en el log):
//   · 'kafka': broker real en localhost:9092 (docker compose up -d).
//   · 'local': sin broker → bus EventEmitter en-proceso. El consumidor
//     (analytics/consumer.js) agrega EXACTAMENTE igual en ambos modos.
//
//  Los módulos del motor (agents/incidents/zones) emiten por el
//  singleton src/kafka/producer.js sin saber de salas: attachEngine()
//  intercepta ese send() y le añade la sala activa (setContext se llama
//  antes del step de cada sala; los ticks son síncronos → sin carreras).
// ════════════════════════════════════════════════════════════════
import { EventEmitter } from 'node:events'
import { Kafka, logLevel } from 'kafkajs'
import { kafka as engineBus } from '../src/kafka/producer.js'
import { kafkaConfig, kafkaBrokers } from './kafkaConfig.js'

export const TOPICS = [
  'room.lifecycle',
  'agent.spawn', 'agent.position', 'agent.arrived', 'agent.reroute',
  'route.decision',
  'incident.start', 'incident.end',
  'zone.red', 'zone.clear',
  'analytics.snapshot',
]

// Topics del contrato con el pipeline Spark (con guion). Separados de TOPICS
// para que el consumidor analítico NO los agregue: `avatar-positions` es el
// feed por-avatar hacia el detector y `red-points` es su salida.
export const INGEST_TOPICS = ['avatar-positions', 'red-points']

// En el CABLE, los topics internos de TOPICS viajan CONSOLIDADOS en un único
// topic físico: cada mensaje lleva su topic lógico en el campo `topic`.
// Motivo: Event Hubs Standard permite máximo 10 event hubs por namespace y
// TOPICS+INGEST suman 13 — los que no se crearan harían fallar la suscripción
// del consumidor y degradarían el bridge entero a modo local (sin Spark).
// Físicos en total: sim-events + avatar-positions + red-points = 3.
export const SIM_EVENTS_TOPIC = 'sim-events'

export class KafkaBridge {
  constructor() {
    this.brokers = kafkaBrokers()   // KAFKA_BOOTSTRAP / Event Hubs / localhost:9092
    this.mode = 'local'
    this.producer = null
    this.emitter = new EventEmitter()   // bus en-proceso (modo local y espejo de depuración)
    this.emitter.setMaxListeners(50)
    this.room = null                    // sala "activa" durante el step actual
    this.published = 0
  }

  async connect() {
    try {
      const client = new Kafka({
        ...kafkaConfig('ecci-server'),   // brokers + SASL/SSL desde el entorno (paridad con Spark)
        logLevel: logLevel.NOTHING,
        retry: { retries: 1, initialRetryTime: 300 },
        connectionTimeout: 2500,
      })
      const producer = client.producer({ allowAutoTopicCreation: true })
      await producer.connect()
      // Pre-crear los topics: el consumidor se suscribe ANTES de que se produzca el
      // primer evento, y Kafka solo auto-crea topics al producir (no al suscribirse).
      // Incluye los topics del contrato Spark (avatar-positions / red-points).
      const admin = client.admin()
      await admin.connect()
      // Topic por topic y con el fallo VISIBLE: un lote con topics ya existentes
      // puede abortar entero en silencio y dejar sin crear el que faltaba (así
      // se perdió sim-events la primera vez, con el catch mudo del lote).
      for (const t of [SIM_EVENTS_TOPIC, ...INGEST_TOPICS]) {
        await admin.createTopics({
          topics: [{ topic: t, numPartitions: 1, replicationFactor: 1 }],
          waitForLeaders: true,
        }).catch(err => console.warn(`[kafka] no se pudo crear el topic ${t}:`, err.message,
          '— si no existe, el consumidor de ese topic va a fallar'))
      }
      await admin.disconnect()
      this.producer = producer
      this.client = client
      this.mode = 'kafka'
      console.log(`[kafka] conectado a ${this.brokers.join(',')} — 3 topics físicos listos (${TOPICS.length} lógicos consolidados en ${SIM_EVENTS_TOPIC})`)
    } catch (err) {
      this.mode = 'local'
      if (process.env.EVENTHUBS_CONNECTION_STRING) {
        // Prod: una connection string mala o un broker inalcanzable NO debe
        // confundirse con "no hay broker en dev". Fallar visible.
        console.error('[kafka] FALLO conectando a Event Hubs (prod):', err.message,
          '— revisa EVENTHUBS_CONNECTION_STRING / KAFKA_BOOTSTRAP. Cayendo a modo LOCAL (sin Spark ni detección).')
      } else {
        console.log('[kafka] broker no disponible — modo LOCAL (bus en-proceso, misma analítica). Levántalo con: npm run kafka:up')
      }
    }
    return this.mode
  }

  // Sala activa: index.js la fija antes de avanzar cada sala en el tick
  setContext(roomCode) { this.room = roomCode }

  // Intercepta el productor simulado del motor compartido: cada kafka.send()
  // de agents/incidents/zones pasa por aquí con la sala del contexto.
  attachEngine() {
    engineBus.send = (topic, payload) => this.publish(topic, payload)
    engineBus.sendBatch = (topic, payloads) => this.publishBatch(topic, payloads)
  }

  publish(topic, payload) {
    const event = { room: this.room, ts: Date.now(), ...payload }
    this.published++
    if (this.mode === 'kafka') {
      // Topics del contrato Spark → tal cual; internos → envelope en sim-events
      // (el topic lógico viaja en el campo `topic` del mensaje).
      const consolidated = !INGEST_TOPICS.includes(topic)
      this.producer
        .send({
          topic: consolidated ? SIM_EVENTS_TOPIC : topic,
          messages: [{
            key: event.room ?? '',
            value: JSON.stringify(consolidated ? { topic, ...event } : event),
          }],
        })
        .catch(err => console.error('[kafka] error publicando', topic, err.message))
    } else {
      // modo local: entrega síncrona al consumidor en-proceso
      this.emitter.emit('event', { topic, event })
    }
  }

  // Igual que publish() pero UN solo produce con N mensajes. Lo usa el feed
  // avatar-positions: hasta ~500 avatares/sala/s en un envío por lote, no 500
  // sends sueltos (evita la ráfaga que bajo carga alta perdía datos en silencio).
  publishBatch(topic, payloads) {
    if (!payloads.length) return
    this.published += payloads.length
    if (this.mode === 'kafka') {
      const messages = payloads.map(p => {
        const event = { room: this.room, ts: Date.now(), ...p }
        return { key: event.room ?? '', value: JSON.stringify(event) }
      })
      this.producer
        .send({ topic, messages })
        .catch(err => console.error('[kafka] error publicando batch', topic, err.message))
    } else {
      for (const p of payloads) {
        this.emitter.emit('event', { topic, event: { room: this.room, ts: Date.now(), ...p } })
      }
    }
  }

  async dispose() {
    try { await this.producer?.disconnect() } catch { /* cerrando */ }
  }
}

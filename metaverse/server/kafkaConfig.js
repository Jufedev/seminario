// ════════════════════════════════════════════════════════════════
//  CONFIG DE CONEXIÓN KAFKA — paridad dev/prod con el detector Python
//  (pipeline/red_point_detector.py). Un solo lugar decide brokers y SASL:
//
//   · Dev (local): KAFKA_BOOTSTRAP (separado por comas) → localhost:9092
//     por defecto. Igual que `os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")`.
//   · Prod (Azure Event Hubs): con EVENTHUBS_CONNECTION_STRING seteado se
//     habla el endpoint Kafka de Event Hubs por SASL_SSL/PLAIN, con
//     username "$ConnectionString" y password = la connection string
//     completa — EXACTAMENTE el jaas config que arma el job de Spark.
//
//  El detector Python toma el bootstrap de KAFKA_BOOTSTRAP y solo añade el
//  SASL desde la connection string. Aquí respetamos KAFKA_BOOTSTRAP si está,
//  y si NO está (pero sí la connection string) derivamos el broker del
//  Endpoint=sb://<ns>.servicebus.windows.net/ → <ns>...:9093, para que
//  configurar solo la connection string ya funcione.
// ════════════════════════════════════════════════════════════════

const DEFAULT_BROKER = 'localhost:9092'

// Extrae "<namespace>.servicebus.windows.net" del Endpoint de una connection
// string de Event Hubs (Endpoint=sb://<namespace>.servicebus.windows.net/).
function eventHubsBroker(connectionString) {
  const m = /Endpoint=sb:\/\/([^/;]+)\/?/i.exec(connectionString)
  if (!m) return null
  return `${m[1]}:9093` // el endpoint Kafka de Event Hubs siempre escucha en 9093
}

function envBrokers() {
  const raw = process.env.KAFKA_BOOTSTRAP
  if (!raw) return null
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : null
}

// Config de kafkajs (Kafka client) lista para `new Kafka({ ...kafkaConfig(id) })`.
export function kafkaConfig(clientId) {
  const conn = process.env.EVENTHUBS_CONNECTION_STRING
  if (conn) {
    const derived = eventHubsBroker(conn)
    const brokers = envBrokers() ?? (derived ? [derived] : null)
    if (!brokers) {
      // No caer a localhost:9092 CON credenciales de Event Hubs: eso es un fallo
      // de conexión casi seguro, que se absorbería en un genérico "modo LOCAL".
      // Fallar claro para no degradar producción en silencio.
      throw new Error(
        'EVENTHUBS_CONNECTION_STRING está seteada pero no pude derivar el broker ' +
          '(Endpoint=sb://<ns>.servicebus.windows.net/ inválido) y KAFKA_BOOTSTRAP no está definido. ' +
          'Corrige la connection string o define KAFKA_BOOTSTRAP=<ns>.servicebus.windows.net:9093.',
      )
    }
    return {
      clientId,
      brokers,
      ssl: true,
      sasl: { mechanism: 'plain', username: '$ConnectionString', password: conn },
    }
  }
  return { clientId, brokers: envBrokers() ?? [DEFAULT_BROKER] }
}

// Solo la lista de brokers (para logs o quien no arma un cliente completo).
export function kafkaBrokers() {
  return kafkaConfig('').brokers
}

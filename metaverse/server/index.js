// ════════════════════════════════════════════════════════════════
//  SERVIDOR AUTORITATIVO (M2) — WebSocket en :8080, salas con código
//  y roles. Cada sala corre SU simulación; el loop global (20 Hz)
//  avanza todas las salas y hace broadcast solo a sus miembros.
//  Protocolo entrante:  join_room { code?, role, name }
//    (admin sin code → crea sala nueva; con code → se une a esa)
//  Protocolo saliente:  room_joined | room_state | join_error
//                       + sim_info | world_snapshot (por sala)
//                       + chat_message (efímero, sin Kafka: ver chat.js)
//                       + drive_state (dirigido al dueño del vehículo personal,
//                         solo cuando cambia: ~1 por cruce, NO va en el snapshot)
//  Arrancar con: make metaverse-server
// ════════════════════════════════════════════════════════════════
import { WebSocketServer } from 'ws'
import { RoomManager } from './rooms.js'
import { buildChatMessage, ChatRateLimiter } from './chat.js'
import { MinIntervalLimiter } from './rateLimit.js'
import { KafkaBridge } from './kafkaProducer.js'
import { AnalyticsConsumer } from '../analytics/consumer.js'
import { RedPointStore } from '../analytics/redPoints.js'

// El productor simulado del motor queda redirigido al puente Kafka (attachEngine);
// se silencia su console.debug para no inundar la consola del servidor.
console.debug = () => {}

const PORT = 8080
const TICK_HZ = 20
const ANALYTICS_EMIT_MS = 1000   // cadencia de admin_analytics
// Piso entre intenciones de giro de un mismo socket. drive_intent es un evento por
// cruce (~1 cada 8 s), no un eje de control: 50 ms sobran para cualquier volante
// humano y le ponen techo a un cliente roto que quiera inundar el tick.
const DRIVE_INTENT_MIN_MS = 50

// ── M5: productor Kafka (o bus local si no hay broker) + consumidor analítico ──
const bridge = new KafkaBridge()
await bridge.connect()
bridge.attachEngine()   // desde aquí, TODO kafka.send() del motor pasa por el puente
const analytics = new AnalyticsConsumer({ bridge })
await analytics.start()
// Zonas rojas desde el detector Spark (topic red-points) — fuente de verdad del
// overlay y el reruteo (reemplaza la detección interna de ZoneSystem).
const redStore = new RedPointStore({ bridge })
await redStore.start()

const rooms = new RoomManager()
const wss = new WebSocketServer({ port: PORT })

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)) }

wss.on('connection', (ws, req) => {
  ws._room = null   // sala a la que pertenece este socket (null hasta join_room)
  ws._chatRate = new ChatRateLimiter()   // higiene de inundación del chat, por socket
  ws._driveRate = new MinIntervalLimiter(DRIVE_INTENT_MIN_MS)   // ídem para el volante
  console.log(`[ws] conexión (${req.socket.remoteAddress}) · sockets: ${wss.clients.size}`)

  ws.on('message', data => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === 'join_room') return handleJoin(ws, msg)
    // El resto de mensajes requieren estar en una sala. El servidor usa SIEMPRE el
    // slot/rol del socket (autoritativo), nunca el userId que diga el cliente.
    const room = ws._room
    if (!room) return
    // Chat de sala: lo mandan usuarios y admin, así que se resuelve ANTES de
    // ramificar por rol. Se queda en la capa WebSocket: ni Kafka ni detector.
    if (msg.type === 'chat_send') {
      const chat = buildChatMessage(room, { role: ws._role, slot: ws._slot }, msg.text)
      if (chat && ws._chatRate.allow()) room.broadcast(chat)
      return
    }
    const sim = room.sim
    bridge.setContext(room.code)   // eventos emitidos por este mensaje → topic con SU sala
    if (ws._role === 'user') {
      if (msg.type === 'set_route' && sim.setUserRoute(ws._slot, msg.origin, msg.dest)) room.broadcast(sim.simInfo())
      else if (msg.type === 'set_fleet' && sim.setUserFleet(ws._slot, msg)) room.broadcast(sim.simInfo())
      else if (msg.type === 'invoke_fleet' && sim.invokeFleet(ws._slot)) room.broadcast(sim.simInfo())
      // invoke_vehicle = el VEHÍCULO PERSONAL del usuario, como en el doc
      else if (msg.type === 'invoke_vehicle' && sim.invokePersonal(ws._slot, 'usuario')) room.broadcast(sim.simInfo())
      // drive_intent = giro pedido para SU vehículo personal. No hay broadcast: el
      // acuse es el drive_state que la simulación encola al dueño por el outbox.
      else if (msg.type === 'drive_intent' && ws._driveRate.allow()) sim.setDriveIntent(ws._slot, msg.dir)
      // drive_throttle = acelerador SOSTENIDO (dos mensajes por pisada, no 20 Hz).
      // El piso se aplica solo al acelerar: descartar un `off` dejaría el vehículo
      // acelerando solo hasta el próximo mensaje, y ese es el peor error posible acá
      // — soltar la tecla SIEMPRE tiene que llegar. Descartar un `on` de más no
      // cuesta nada: el auto se queda quieto, que es su estado por defecto.
      else if (msg.type === 'drive_throttle' && (!msg.on || ws._driveRate.allow())) {
        sim.setDriveThrottle(ws._slot, !!msg.on)
      }
    } else if (ws._role === 'admin') {
      if (msg.type === 'admin_set_incidents') { sim.setIncidentFreq(msg.freq); room.broadcast(sim.simInfo()) }
      else if (msg.type === 'admin_control' && sim.control(msg.action)) {
        room.broadcast(sim.simInfo())
        room.broadcastState()   // running cambió → refrescar room_state en todos
      }
      // tras la alerta, el admin puede invocar el vehículo personal de un usuario
      else if (msg.type === 'admin_invoke_user' && sim.invokePersonal(Number(msg.userId), 'admin')) room.broadcast(sim.simInfo())
    }
  })
  ws.on('close', () => {
    const room = ws._room
    if (room) {
      // Se cayó con el acelerador pisado: el `off` de la tecla no va a llegar nunca.
      // Sin esto el vehículo sigue acelerando solo, sin dueño, hasta su destino.
      if (ws._role === 'user') room.sim?.setDriveThrottle(ws._slot, false)
      room.leave(ws)
      room.broadcastState()
      bridge.publish('room.lifecycle', { room: room.code, action: 'leave', role: ws._role, userId: ws._slot })
      console.log(`[room] ${room.code}: alguien salió · admin:${!!room.admin} miembros:${room.members().length}`)
    }
    ws._room = null
  })
  ws.on('error', () => {})   // evita crash por sockets rotos
})

function handleJoin(ws, { code, role, name }) {
  name = String(name || '').trim().slice(0, 20) || (role === 'admin' ? 'Admin' : 'Usuario')
  role = role === 'admin' ? 'admin' : 'user'

  // Admin sin código = crear sala; cualquier otro caso = buscar la sala existente
  let room
  if (role === 'admin' && !code) {
    room = rooms.create()
    bridge.publish('room.lifecycle', { room: room.code, action: 'created' })
  } else {
    room = rooms.get(String(code || '').trim().toUpperCase())
    if (!room) return send(ws, { type: 'join_error', reason: `No existe la sala "${code}"` })
  }

  if (ws._room) { ws._room.leave(ws); ws._room.broadcastState() }   // estaba en otra sala

  let slot
  if (role === 'admin') {
    if (!room.joinAdmin(ws, name)) return send(ws, { type: 'join_error', reason: 'La sala ya tiene admin' })
    slot = 0
  } else {
    slot = room.joinUser(ws, name)
    if (slot < 0) return send(ws, { type: 'join_error', reason: 'Sala llena (máximo 3 usuarios)' })
  }

  ws._room = room
  ws._role = role
  ws._slot = slot
  bridge.publish('room.lifecycle', { room: room.code, action: 'join', role, userId: slot, name })
  send(ws, { type: 'room_joined', code: room.code, role, slot, name })
  send(ws, room.sim.simInfo())    // estado de la corrida en curso, para pintar de inmediato
  room.broadcastState()
  console.log(`[room] ${room.code}: entra ${role === 'admin' ? 'ADMIN' : `Usuario ${slot}`} "${name}"`)
}

// ── Loop global: avanza TODAS las salas y les manda su snapshot ──
let last = performance.now()
setInterval(() => {
  const now = performance.now()
  const dt = Math.min((now - last) / 1000, 0.1)
  last = now
  for (const room of rooms.all()) {
    bridge.setContext(room.code)   // los eventos del step llevan la sala correcta
    // Zonas rojas de Spark POR SALA (con TTL): las propias de la sala + las globales.
    room.sim.applySparkRedZones(redStore.activeZonesFor(room.code))   // overlay + reruteo desde Spark, no ZoneSystem
    room.sim.step(dt)
    if (room.sim.run !== room.lastRun) {       // corrida nueva de ESTA sala
      room.lastRun = room.sim.run
      // Reset (o primer arranque): soltá las zonas rojas acumuladas de la sala y
      // descartá los red-points rezagados de la ventana Spark previa al reset, para
      // que no reaparezcan zonas fantasma sobre una sala recién reiniciada.
      redStore.markReset(room.code)
      room.broadcast(room.sim.simInfo())
    }
    // Mensajes dirigidos: alertas al admin
    for (const out of room.sim.drainOutbox()) {
      if (out.to === 'admin') { if (room.admin) send(room.admin, out.msg) }
      else { const u = room.users[out.to - 1]; if (u) send(u.ws, out.msg) }
    }
    // Feed por-avatar hacia el detector Spark (~1 Hz, solo con la sala en marcha)
    if (room.sim.running) room.sim.maybeSampleAvatarPositions(dt, room.code)
    room.broadcast(room.sim.snapshot())
  }
  // Las salas destruidas se olvidan también en el store de zonas rojas: su código
  // se recicla, y lo que quede indexado ahí se lo heredaría la próxima sala.
  for (const code of rooms.sweep()) redStore.forgetRoom(code)
}, 1000 / TICK_HZ)

// ── Emisión de analítica (cada ~1s): el consumidor agrega, el server la manda al
//    admin. La analítica de la sala vive SOLO en el tablero del admin; el desglose
//    por usuario viaja dentro de admin_analytics (metricsForAdmin arma perUser con
//    metricsForUser), así que no hay emisión por socket de usuario.
setInterval(() => {
  for (const room of rooms.all()) {
    // Zonas rojas del detector Spark (fuente de verdad): alimentan el KPI y la
    // serie roja del consumidor ANTES de armar las métricas, y el heatmap del admin.
    // Se anotan aunque el admin esté desconectado: la serie de la sala no puede
    // quedar con huecos por quién esté mirando.
    const sparkRedZones = redStore.activeZonesFor(room.code)
    analytics.noteSparkRedZones(room.code, sparkRedZones.length)
    if (room.admin) {
      const metrics = analytics.metricsForAdmin(room.code)
      const detection = redStore.detectionStatsFor(room.code)
      if (metrics) send(room.admin, { type: 'admin_analytics', ...metrics, sparkRedZones, detection })
    }
  }
}, ANALYTICS_EMIT_MS)

// ── Latido de observabilidad (~30s): una línea con los contadores vivos, para
//    ver de un vistazo si el flujo Kafka sigue moviéndose (o se congeló en silencio).
setInterval(() => {
  console.log(`[heartbeat] kafka:${bridge.mode} · publicados:${bridge.published} · redpoints:${redStore.consumed} · analytics:${analytics.consumed}`)
}, 30_000)

// ── Cierre limpio: desconecta productor/consumidores para que los grupos hagan
//    LeaveGroup y el rebalanceo del próximo arranque sea inmediato (no espera al
//    session timeout). Sin esto, cada redeploy deja el grupo colgado ~10-30s.
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[ws] ${signal} recibido — cerrando…`)
  try { wss.close() } catch { /* ya cerrado */ }
  await Promise.allSettled([bridge.dispose(), analytics.dispose(), redStore.dispose()])
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log(`[ws] servidor de salas escuchando en ws://localhost:${PORT} · tick ${TICK_HZ} Hz · kafka: ${bridge.mode}`)

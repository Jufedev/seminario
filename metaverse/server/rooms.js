// ════════════════════════════════════════════════════════════════
//  SALAS (M2) — cada sala tiene un código único "ECCI-XXXX", máximo
//  1 admin + 3 usuarios, y SU PROPIA simulación autoritativa.
//  Nota para M3: el grafo (mapData.js) es un módulo compartido entre
//  salas; hoy nadie lo muta (sin incidentes en el server), pero cuando
//  cada sala tenga incidentes propios necesitará su copia del grafo.
// ════════════════════════════════════════════════════════════════
import { Simulation } from './simulation.js'

const MAX_USERS = 3
const EMPTY_ROOM_TTL_MS = 60_000   // sala sin nadie durante 1 min → se destruye

export class Room {
  constructor(code) {
    this.code = code
    this.admin = null                        // ws del admin (o null si se desconectó)
    this.adminName = null
    this.users = [null, null, null]          // índice 0..2 = Usuario 1..3 {ws, name}
    this.sim = new Simulation(code)
    this.lastRun = this.sim.run
    this.emptySince = Date.now()
  }

  members() {
    const out = []
    if (this.admin) out.push(this.admin)
    for (const u of this.users) if (u) out.push(u.ws)
    return out
  }

  joinAdmin(ws, name) {
    if (this.admin) return false
    this.admin = ws
    this.adminName = name
    this.emptySince = null
    return true
  }

  // Asigna el slot libre más bajo (Usuario 1/2/3); -1 si está llena
  joinUser(ws, name) {
    for (let i = 0; i < MAX_USERS; i++) {
      if (!this.users[i]) {
        this.users[i] = { ws, name }
        this.emptySince = null
        return i + 1
      }
    }
    return -1
  }

  leave(ws) {
    if (this.admin === ws) { this.admin = null; this.adminName = null }
    for (let i = 0; i < MAX_USERS; i++) if (this.users[i]?.ws === ws) this.users[i] = null
    if (!this.members().length) this.emptySince = Date.now()
  }

  roomState() {
    return {
      type: 'room_state',
      code: this.code,
      adminReady: !!this.admin,
      running: this.sim.running,              // M3: lo controla el admin (start/pause/reset)
      admin: this.adminName,
      users: this.users.flatMap((u, i) => u ? [{ slot: i + 1, name: u.name }] : []),
    }
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj)
    for (const ws of this.members()) if (ws.readyState === 1 /* OPEN */) ws.send(msg)
  }

  broadcastState() { this.broadcast(this.roomState()) }
}

export class RoomManager {
  constructor() { this.rooms = new Map() }   // code → Room

  create() {
    let code
    do { code = `ECCI-${String(Math.floor(1000 + Math.random() * 9000))}` } while (this.rooms.has(code))
    const room = new Room(code)
    this.rooms.set(code, room)
    console.log(`[room] sala creada ${code} · salas activas: ${this.rooms.size}`)
    return room
  }

  get(code) { return this.rooms.get(code) ?? null }
  all() { return this.rooms.values() }

  // Limpieza periódica de salas abandonadas (la llama el loop de tick)
  sweep() {
    const now = Date.now()
    for (const [code, room] of this.rooms) {
      if (room.emptySince != null && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(code)
        console.log(`[room] sala ${code} destruida por inactividad · salas activas: ${this.rooms.size}`)
      }
    }
  }
}

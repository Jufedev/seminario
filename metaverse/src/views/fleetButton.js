// ════════════════════════════════════════════════════════════════
//  BOTÓN "INVOCAR FLOTA" — regla pura de habilitación.
//  La flota se invoca UNA vez por corrida: mientras la sala no se
//  reinicie, el botón queda bloqueado. El estado no lo recuerda el
//  cliente: lo dicta el servidor en cada sim_info a través de
//  fleets[].invoked, que resetAgents() vuelve a false en el reset
//  del admin. Así el bloqueo sobrevive a recargas y reconexiones.
// ════════════════════════════════════════════════════════════════

// fleet: la entrada de sim_info.fleets del usuario que mira (o null/undefined
// si el servidor todavía no conoce su flota).
export function fleetButtonDisabled(fleet) {
  return !(fleet && fleet.origin && fleet.dest && !fleet.invoked)
}

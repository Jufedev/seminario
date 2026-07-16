// ════════════════════════════════════════════════════════════════
//  BLOQUEOS DE INVOCACIÓN — reglas puras de los controles del usuario.
//  Todo lo que se invoca se invoca UNA vez por corrida: la flota, el
//  vehículo personal y, en consecuencia, los puntos de origen/destino
//  con los que se invocaron. Mientras la sala no se reinicie, esos
//  controles quedan bloqueados.
//
//  El estado no lo recuerda el cliente: lo dicta el servidor en cada
//  sim_info (fleets[].invoked y fleets[].personal.invoked), que
//  resetAgents() vuelve a false en el reset del admin. Así el bloqueo
//  sobrevive a recargas y reconexiones.
// ════════════════════════════════════════════════════════════════

// En los predicados, `fleet` es la entrada de sim_info.fleets del usuario que
// mira (o null/undefined si el servidor todavía no conoce su flota).

// Flota: hace falta ruta completa y no haberla invocado.
export function fleetButtonDisabled(fleet) {
  return !(fleet && fleet.origin && fleet.dest && !fleet.invoked)
}

// Vehículo personal: misma regla, pero sobre personal.invoked. NO sobre
// personal.active, que vuelve a false cuando el vehículo LLEGA: con active el
// botón se reabría a mitad de corrida y se podía invocar un segundo vehículo.
export function personalButtonDisabled(fleet) {
  return !(fleet && fleet.origin && fleet.dest && !fleet.personal?.invoked)
}

// Rótulo del botón personal: el botón es la única fila que reporta el estado
// del vehículo, así que distingue "va en camino" de "ya llegó" (los dos
// bloqueados, pero por razones distintas).
export function personalButtonLabel(fleet) {
  const p = fleet?.personal
  if (p?.active) return '🚗 Mi vehículo va en camino'
  if (p?.invoked) return '🚗 Mi vehículo ya llegó'
  return '🚗 Invocar MI vehículo'
}

// Puntos de origen/destino: se congelan en cuanto el usuario invoca CUALQUIER
// cosa (retro del jurado). Cambiar la ruta con la flota ya rodando dejaba a los
// vehículos viajando por la ruta vieja; congelados los puntos, esa divergencia
// no existe. Antes de invocar nada se eligen libremente.
export function routeSelectsDisabled(fleet) {
  return !!(fleet && (fleet.invoked || fleet.personal?.invoked))
}

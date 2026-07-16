// ════════════════════════════════════════════════════════════════
//  CÁMARA — reglas puras del selector de vista del usuario.
//  Dos modos: cenital (2d) y conductor (chase, pegada al vehículo
//  personal).
//
//  Como en driveControls.js, el estado no lo recuerda el cliente: la
//  disponibilidad del modo conductor la dicta sim_info
//  (fleets[].personal.active), el mismo campo que abre el volante.
//  Sin vehículo personal rodando no hay a quién seguir.
// ════════════════════════════════════════════════════════════════

// Los modos que OFRECE el panel del usuario. onlineWorld entiende además '3d'
// (órbita libre), que se queda para el admin: el usuario tiene un vehículo y dos
// vistas con sentido —el mapa o el volante—, y una órbita libre en el medio solo
// agrega una vista que no contesta ninguna pregunta suya.
export const CAM_MODES = ['2d', 'chase']

// Modo al que se cae cuando el conductor deja de estar disponible. Es '2d' y no
// '3d' a propósito: las zonas rojas son planos a ras del piso y desde una cámara
// baja se ven casi de canto. La cenital es la única vista donde se lee sin
// esfuerzo lo único que produce toda la cadena Kafka→Spark.
export const CAM_FALLBACK = '2d'

// El modo conductor sigue al vehículo personal, así que solo existe mientras el
// vehículo rueda. Mismo criterio que driveControlsVisible: manda `active`, no
// `invoked` — a un vehículo que ya llegó no se lo sigue.
export function chaseAvailable(fleet) {
  return !!fleet?.personal?.active
}

// Modo que corresponde tras un sim_info. Dos movimientos automáticos, y ninguno
// más: la vista es del usuario.
//
//  · El vehículo ACABA de salir a la vía (no estaba y ahora sí) → subirse al
//    conductor. Invocar el vehículo y tener que buscar el botón de la cámara son
//    dos pasos para una sola intención.
//  · El vehículo dejó la vía mientras se lo seguía → caer a la cenital, que si no
//    la cámara queda congelada mirando una calle vacía.
//
// Manda la TRANSICIÓN, no el estado: `wasAvailable` es lo que hace que el usuario
// pueda volverse a la cenital con el vehículo rodando y quedarse ahí. Si esto
// mirara solo `chaseAvailable(fleet)`, cada sim_info lo devolvería al conductor y
// el botón 2D no serviría para nada mientras maneja.
export function camModeAfterFleet({ mode, wasAvailable, fleet }) {
  const available = chaseAvailable(fleet)
  if (available && !wasAvailable) return 'chase'
  if (!available && mode === 'chase') return CAM_FALLBACK
  return mode
}

// Velocidad MEDIDA por desplazamiento — función pura, extraída para poder
// testearla y BLINDAR la propiedad crítica de la tesis: un avatar detenido debe
// reportar ~0 (NO su velocidad deseada), o el detector Spark (filtro speed<0.5)
// quedaría ciego a los atascos. Es el error crítico que ya se corrigió una vez
// en la integración v1; el test lo fija para que un refactor no lo revierta.
//
//   dx, dz        desplazamiento entre emisiones, en unidades de mundo
//   dtSec         segundos transcurridos entre emisiones (de pared)
//   unitToMeters  factor unidades→metros (UNIT_TO_METERS)
export function measuredSpeedMps(dx, dz, dtSec, unitToMeters) {
  return (Math.hypot(dx, dz) * unitToMeters) / Math.max(0.001, dtSec)
}

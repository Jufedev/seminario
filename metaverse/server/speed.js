// Velocidad MEDIDA por desplazamiento — función pura, extraída para poder
// testearla y BLINDAR la propiedad crítica de la tesis: un avatar detenido debe
// reportar ~0 (NO su velocidad deseada), o el detector Spark (filtro speed<0.5)
// quedaría ciego a los atascos: un auto encolado sigue QUERIENDO ir rápido. El
// test lo fija para que un refactor no lo revierta.
//
//   dx, dz        desplazamiento entre emisiones, en unidades de mundo
//   dtSec         segundos transcurridos entre emisiones (de pared)
//   unitToMeters  factor unidades→metros (UNIT_TO_METERS)
export function measuredSpeedMps(dx, dz, dtSec, unitToMeters) {
  return (Math.hypot(dx, dz) * unitToMeters) / Math.max(0.001, dtSec)
}

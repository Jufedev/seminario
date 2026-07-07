import { POINTS, CATEGORIES } from '../graph/mapData.js'

// ════════════════════════════════════════════════════════════════
//  SELECTOR DE ORIGEN/DESTINO — helper compartido: genera los
//  <option> agrupados por categoría para los <select> de los 15
//  puntos. Lo reutiliza la vista de usuario online (userView.js).
// ════════════════════════════════════════════════════════════════

// <option> agrupados por categoría, para los dos <select> de origen/destino
export function buildOptions(selectedId) {
  let html = `<option value="">— sin elegir —</option>`
  for (const catId in CATEGORIES) {
    html += `<optgroup label="${CATEGORIES[catId].label}">`
    for (const p of POINTS.filter(pt => pt.cat === catId)) {
      html += `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${p.id} · ${p.name}</option>`
    }
    html += `</optgroup>`
  }
  return html
}

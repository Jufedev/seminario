import { navigate } from '../router.js'

// ════════════════════════════════════════════════════════════════
//  VISTA 1 — PORTADA: título, integrantes, pregunta problema, inicio
// ════════════════════════════════════════════════════════════════
export function renderPortada(app) {
  const view = document.createElement('div')
  view.className = 'view-portada'
  view.innerHTML = `
    <div style="font-size:48px">🏙️</div>
    <h1>ECCI Metaverso — Simulador de Tráfico BigData</h1>
    <p class="subtitle">
      Simulador de navegación urbana masiva sobre el trazado real entre las sedes de la
      Universidad ECCI en el sector de Galerías/Chapinero, Bogotá. Hasta 500 avatares
      (vehículos) circulan simultáneamente por la ciudad; el sistema genera eventos de
      tráfico e incidentes en tiempo real y una capa de analítica de BigData detecta
      zonas congestionadas para recalcular rutas automáticamente.
    </p>
    <div class="pregunta">
      <strong>Pregunta problema</strong>
      ¿Cómo analizar eventos de usuarios en tiempo real para detectar comportamientos relevantes?
    </div>
    <div class="integrantes">
      <span class="chip">Integrante 1</span>
      <span class="chip">Integrante 2</span>
      <span class="chip">Integrante 3</span>
      <span class="chip">Integrante 4</span>
    </div>
    <div style="display:flex;gap:12px">
      <button class="btn" id="btn-online">🌐 Multi-usuario</button>
    </div>
    <p style="font-size:11px;color:var(--text-dim)">El modo multi-usuario requiere el servidor: <code>npm run server</code></p>
  `
  app.appendChild(view)
  view.querySelector('#btn-online').addEventListener('click', () => navigate('#/lobby'))
}

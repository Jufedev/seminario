import { navigate } from '../router.js'

// ════════════════════════════════════════════════════════════════
//  VISTA 1 — PORTADA: título, integrantes, pregunta problema, inicio
// ════════════════════════════════════════════════════════════════
export function renderPortada(app) {
  const view = document.createElement('div')
  view.className = 'view-portada'
  view.innerHTML = `
    <div style="font-size:48px">🏙️</div>
    <h1>Diseño y prototipo para la detección de comportamientos relevantes de usuarios
      en el metaverso a través de streaming y filtrado de datos.</h1>
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
  `
  app.appendChild(view)
  view.querySelector('#btn-online').addEventListener('click', () => navigate('/lobby'))
}

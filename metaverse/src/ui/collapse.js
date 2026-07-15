// ════════════════════════════════════════════════════════════════
//  COLAPSAR PANELES FLOTANTES — los paneles se posan sobre el mapa,
//  justo donde se arman las colas y el detector marca las zonas
//  rojas; ese resultado es lo que hay que ver. Todos se pliegan con
//  el mismo gesto (queda solo la barra del título) y con el mismo
//  mecanismo, para que el usuario no tenga que aprender dos.
//  El estilo lo pone la clase 'collapsed' de cada panel (style.css).
// ════════════════════════════════════════════════════════════════
export function wireCollapseToggle(panel, toggle) {
  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed')
    toggle.textContent = collapsed ? '▸' : '▾'
  })
}

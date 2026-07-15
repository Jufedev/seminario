// Una fila de la lista "En la sala", compartida por las dos vistas (admin y
// usuario): la lista es la misma pregunta en ambas ("quién está y cuál soy yo"),
// así que la responde un solo constructor.
//
// El punto de color ya dice qué slot es cada quien, así que la fila muestra el
// NOMBRE de la persona y nada más. La fila de quien mira va resaltada y con la
// etiqueta "tú" en su propio color: sin chip de rol en el borde superior, esta
// lista es lo único que identifica al espectador.
//
// El nombre es texto ajeno (el servidor no lo sanea): SIEMPRE por textContent,
// NUNCA por innerHTML.
export function memberRow(mark, color, text, isMe) {
  const row = document.createElement('div')
  row.className = isMe ? 'hud-member is-me' : 'hud-member'
  const dot = document.createElement('span')
  dot.style.color = color
  dot.textContent = mark
  const who = document.createElement('span')
  who.textContent = text
  row.append(dot, who)
  if (isMe) {
    const me = document.createElement('b')
    me.className = 'hud-me'
    me.style.color = color
    me.textContent = 'tú'
    row.appendChild(me)
  }
  return row
}

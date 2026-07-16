import * as THREE from 'three'
import { chatOpacity, chatExpired } from './chatTiming.js'

// ════════════════════════════════════════════════════════════════
//  BURBUJAS DE CHAT — el mensaje flotando sobre la cabeza del avatar.
//  Es lo que hace VISIBLE la interacción entre avatares; el panel de
//  historial es secundario.
//  Se dibujan como Sprite (billboard) porque las dos vistas miran el
//  mundo distinto: el usuario en ortográfica cenital y el admin en
//  perspectiva navegable. Un sprite encara la cámara en ambas. Los
//  rótulos de worldBuilders.js no sirven: están acostados sobre el
//  suelo y en 3D se leerían de canto. La textura se arma en un canvas,
//  con el mismo procedimiento de makeLabel().
//  Cuánto se queda y cómo se va NO se deciden aquí: salen de
//  chatTiming.js, que comparte con el anuncio del admin.
// ════════════════════════════════════════════════════════════════
const FONT_PX = 34
const LINE_PX = 44
const MAX_LINE_CHARS = 24   // ancho de línea (se parte por palabras)…
const MAX_LINES = 3         // …y alto máximo: lo que sobra se corta
const PX_PER_UNIT = 6       // px de canvas → unidades de mundo
const HEAD_ROOM = 5         // altura sobre el techo del avatar (vista 3D)

// Parte el texto en líneas respetando palabras. Si no cabe en MAX_LINES se
// recorta con puntos suspensivos: el historial conserva el texto completo, la
// burbuja solo tiene que quedar legible sobre el mapa.
// Pura y exportada para poder testearla: el render 3D no se puede verificar en
// consola, pero el recorte sí (es lo que evita una burbuja que tape el mapa).
export function wrapLines(text) {
  const lines = []
  let line = ''
  const push = () => { if (line) { lines.push(line); line = '' } }
  for (let word of text.split(' ')) {
    while (word.length > MAX_LINE_CHARS) {   // palabra suelta más larga que la línea
      push()
      lines.push(word.slice(0, MAX_LINE_CHARS))
      word = word.slice(MAX_LINE_CHARS)
    }
    if (!word) continue
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= MAX_LINE_CHARS) line = candidate
    else { push(); line = word }
  }
  push()
  if (lines.length <= MAX_LINES) return lines
  const cut = lines.slice(0, MAX_LINES)
  cut[MAX_LINES - 1] = `${cut[MAX_LINES - 1].slice(0, MAX_LINE_CHARS - 1)}…`
  return cut
}

// Globo (fondo del panel + borde del color del dueño) con el texto centrado.
// El texto entra por fillText, nunca por HTML: aquí no hay superficie de inyección.
function makeBubbleSprite(text, color) {
  const lines = wrapLines(text)
  const font = `600 ${FONT_PX}px 'Segoe UI', sans-serif`
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = font
  const padX = 22, padY = 16
  const cnv = document.createElement('canvas')
  cnv.width = Math.ceil(Math.max(...lines.map(l => probe.measureText(l).width))) + padX * 2
  cnv.height = lines.length * LINE_PX + padY * 2

  const c2 = cnv.getContext('2d')
  c2.beginPath()
  // roundRect existe en los navegadores actuales; sin él, un rectángulo recto sirve
  if (c2.roundRect) c2.roundRect(1.5, 1.5, cnv.width - 3, cnv.height - 3, 14)
  else c2.rect(1.5, 1.5, cnv.width - 3, cnv.height - 3)
  c2.fillStyle = 'rgba(15,21,33,0.92)'
  c2.fill()
  c2.strokeStyle = color
  c2.lineWidth = 3
  c2.stroke()
  c2.font = font
  c2.textAlign = 'center'
  c2.textBaseline = 'middle'
  c2.fillStyle = '#e2eaf5'
  lines.forEach((l, i) => c2.fillText(l, cnv.width / 2, padY + LINE_PX * (i + 0.5)))

  const tex = new THREE.CanvasTexture(cnv)
  tex.anisotropy = 4
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false,   // siempre por encima de vías y autos
  }))
  sprite.renderOrder = 10
  sprite.scale.set(cnv.width / PX_PER_UNIT, cnv.height / PX_PER_UNIT, 1)
  return sprite
}

// Qué burbujas sobran, dado quién sigue en la sala. Pura y exportada —como
// wrapLines— para poder probarla sin THREE ni canvas: el resto de este módulo
// necesita las dos cosas y solo se prueba en el navegador.
export function staleChatSlots(bubbleSlots, memberSlots) {
  const vivos = new Set(memberSlots)
  return [...bubbleSlots].filter(slot => !vivos.has(slot))
}

export function createChatBubbles(scene) {
  const bubbles = new Map()   // slot → { sprite, born }

  function drop(slot) {
    const b = bubbles.get(slot)
    if (!b) return
    b.sprite.removeFromParent()
    b.sprite.material.map.dispose()
    b.sprite.material.dispose()
    bubbles.delete(slot)
  }

  return {
    // Un mensaje nuevo REEMPLAZA al anterior del mismo avatar: encolarlos dejaría
    // burbujas apiladas e ilegibles en cuanto alguien escriba rápido.
    say(slot, text, color) {
      drop(slot)
      const sprite = makeBubbleSprite(text, color)
      sprite.visible = false   // hasta que update() le encuentre el avatar
      scene.add(sprite)
      bubbles.set(slot, { sprite, born: performance.now() })
    },

    // anchors: slot → avatar que habla. `flat` (vista 2D cenital) corre la burbuja
    // al norte, que en esa cámara es "arriba en pantalla"; en 3D basta con subirla
    // sobre el techo. Sin avatar en pista, la burbuja espera oculta (no se pierde:
    // el mensaje ya está en el panel de historial).
    update(now, anchors, flat) {
      for (const [slot, b] of bubbles) {
        const age = now - b.born
        if (chatExpired(age)) { drop(slot); continue }
        const at = anchors.get(slot)
        b.sprite.visible = !!at
        if (!at) continue
        const half = b.sprite.scale.y / 2
        b.sprite.position.set(at.x, HEAD_ROOM + half, flat ? at.z - half - 4 : at.z)
        b.sprite.material.opacity = chatOpacity(age)
      }
    },

    // Se fue quien hablaba: su burbuja se va con él. El Map se indexa por SLOT, y el
    // servidor recicla el slot libre más bajo al siguiente que entra (rooms.js), así
    // que una burbuja que sobrevive a su autor queda apuntando a una casilla que ya
    // es de otra persona. Hoy no se ve —el candado de invocación le deja el botón
    // bloqueado al nuevo, así que no llega a tener avatar en ese slot hasta un
    // reinicio, y el reinicio borra los dos—, pero eso es estar a salvo por un
    // invariante AJENO: el día que alguien libere `personalInvoked` al salir (un
    // cambio razonable: ¿por qué queda trabado el slot de alguien que se fue?), el
    // mensaje de uno aparecería sobre el avatar de otro. Se corta acá, que es el
    // único lado que sabe de quién es cada burbuja.
    keepOnly(slots) {
      for (const slot of staleChatSlots(bubbles.keys(), slots)) drop(slot)
    },

    dispose() { for (const slot of [...bubbles.keys()]) drop(slot) },
  }
}

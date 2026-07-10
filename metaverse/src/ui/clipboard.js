// Copia texto al portapapeles con degradación: la Clipboard API solo existe en
// contextos seguros (https o localhost); servido por http desde la VM se usa el
// fallback de execCommand. Devuelve true si la copia funcionó.
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* cae al fallback */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()
  return ok
}

// Cablea un botón "copiar" con feedback visual (✓ / ✗ y vuelve al ícono).
export function wireCopyButton(btn, getText) {
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText())
    btn.textContent = ok ? '✓' : '✗'
    btn.classList.toggle('copied', ok)
    setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied') }, 1500)
  })
}

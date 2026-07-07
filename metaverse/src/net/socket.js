// ════════════════════════════════════════════════════════════════
//  SOCKET — conexión WebSocket al servidor autoritativo, con
//  reconexión automática (backoff exponencial, tope 5s).
//  onMessage recibe cada mensaje ya parseado; onStatus informa
//  'connecting' | 'open' | 'closed' para pintar el estado en el HUD.
// ════════════════════════════════════════════════════════════════
export function connectSocket({ url, onMessage, onStatus }) {
  let ws = null
  let closed = false   // cierre intencional (teardown de la vista): no reconectar
  let retry = 0

  function open() {
    onStatus?.('connecting')
    ws = new WebSocket(url)
    ws.onopen = () => { retry = 0; onStatus?.('open') }
    ws.onmessage = e => {
      try { onMessage?.(JSON.parse(e.data)) } catch { /* mensaje corrupto: ignorar */ }
    }
    ws.onclose = () => {
      onStatus?.('closed')
      if (!closed) setTimeout(open, Math.min(500 * 2 ** retry++, 5000))
    }
    ws.onerror = () => ws.close()
  }
  open()

  return {
    send: obj => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) },
    close: () => { closed = true; ws?.close() },
  }
}

// El servidor corre en la misma máquina/red que sirve el cliente (puerto 8080)
export const defaultServerUrl = () => `ws://${location.hostname}:8080`

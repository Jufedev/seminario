// ════════════════════════════════════════════════════════════════
//  GRAFO DEL SERVIDOR — el grafo + Dijkstra viven en src/graph/mapData.js
//  y se COMPARTEN con el cliente (misma fuente, cero duplicación).
//  El SERVIDOR es la fuente de verdad: solo él muta el grafo en línea
//  (bloqueos/penalizaciones llegarán en fases M3+); el cliente lo usa
//  únicamente para dibujar vías y rótulos.
// ════════════════════════════════════════════════════════════════
export * from '../src/graph/mapData.js'

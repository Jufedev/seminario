#!/usr/bin/env bash
# Un solo comando para levantar el loop local completo (dentro del distrobox):
#   Kafka (espera a que ACEPTE conexiones) -> detector Spark -> servidor -> web.
# Ctrl-C baja los tres procesos. Kafka QUEDA corriendo entre iteraciones (es un
# daemon barato y pararlo en cada Ctrl-C hacía que el siguiente arranque corriera
# una carrera contra su propio timeout); bajalo a mano con: make kafka-stop
# Los logs quedan en logs/.
set -uo pipefail
cd "$(dirname "$0")/.."

mkdir -p logs
[ -f .env ] || cp env/env.dev.example .env

# Pre-flight: un servidor huérfano de una corrida anterior agarrando :8080 hace
# crashear al nuevo con "port in use". Barrer restos ANTES de arrancar.
pkill -f 'bun server/index.js' 2>/dev/null && sleep 1 || true
pkill -f 'pipeline/red_point_detector.py' 2>/dev/null || true

echo "▶ Arrancando Kafka…"
make kafka-start >/dev/null 2>&1 || true

# Esperar a que el broker ACEPTE conexiones (no solo a que el proceso exista):
# el servidor tiene 2.5 s de timeout y, si Kafka no está lista, cae a modo LOCAL.
kafka_bin="$(ls -d "$HOME"/.local/kafka_*/bin 2>/dev/null | head -1)"
ready=0
for _ in $(seq 1 60); do
  if "$kafka_bin/kafka-broker-api-versions.sh" --bootstrap-server localhost:9092 >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" = 1 ]; then
  echo "  Kafka lista (acepta conexiones)."
else
  # Sin broker el server caería a modo LOCAL en silencio (sin zonas rojas) y el
  # detector moriría reintentando: mejor frenar acá con el diagnóstico claro.
  echo "  ✗ Kafka no aceptó conexiones tras 60 s. Revisa: ./scripts/kafka-local.sh logs"
  exit 1
fi

pids=()
cleanup() {
  echo; echo "▶ Bajando detector, servidor y web… (Kafka queda corriendo; make kafka-stop para bajarlo)"
  # Matar el GRUPO de procesos de cada componente: kill al wrapper de make deja
  # vivos a sus hijos (bun/java) y el siguiente arranque choca con el :8080.
  for p in "${pids[@]:-}"; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done
  echo "  Listo."
}
trap cleanup INT TERM EXIT

echo "▶ Detector Spark…   (logs/detector.log — la 1ª vez baja el conector, ~1 min)"
setsid make detector          >logs/detector.log 2>&1 & pids+=($!)
echo "▶ Servidor…         (logs/server.log)"
setsid make metaverse-server  >logs/server.log 2>&1 & pids+=($!)
echo "▶ Cliente web…      (logs/web.log)"
setsid make metaverse-web     >logs/web.log 2>&1 & pids+=($!)

echo
echo "Todo levantado. La URL del navegador está en logs/web.log (Vite, típico http://localhost:5173)."
echo "Siguiendo logs — Ctrl-C corta los procesos (Kafka queda arriba):"
echo
tail -f logs/detector.log logs/server.log logs/web.log

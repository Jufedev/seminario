#!/usr/bin/env bash
# Un solo comando para levantar el loop local completo (dentro del distrobox):
#   Kafka (espera a que ACEPTE conexiones) -> detector Spark -> servidor -> web.
# Ctrl-C baja todo (los tres procesos + Kafka). Los logs quedan en logs/.
set -uo pipefail
cd "$(dirname "$0")/.."

mkdir -p logs
[ -f .env ] || cp env/env.dev.example .env

echo "▶ Arrancando Kafka…"
make kafka-start >/dev/null 2>&1 || true

# Esperar a que el broker ACEPTE conexiones (no solo a que el proceso exista):
# el servidor tiene 2.5 s de timeout y, si Kafka no está lista, cae a modo LOCAL.
kafka_bin="$(ls -d "$HOME"/.local/kafka_*/bin 2>/dev/null | head -1)"
ready=0
for _ in $(seq 1 30); do
  if "$kafka_bin/kafka-broker-api-versions.sh" --bootstrap-server localhost:9092 >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" = 1 ]; then
  echo "  Kafka lista (acepta conexiones)."
else
  echo "  ⚠ Kafka no respondió a tiempo; el servidor podría caer a modo local."
fi

pids=()
cleanup() {
  echo; echo "▶ Bajando todo…"
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  make kafka-stop >/dev/null 2>&1 || true
  echo "  Listo."
}
trap cleanup INT TERM EXIT

echo "▶ Detector Spark…   (logs/detector.log — la 1ª vez baja el conector, ~1 min)"
make detector          >logs/detector.log 2>&1 & pids+=($!)
echo "▶ Servidor…         (logs/server.log)"
make metaverse-server  >logs/server.log 2>&1 & pids+=($!)
echo "▶ Cliente web…      (logs/web.log)"
make metaverse-web     >logs/web.log 2>&1 & pids+=($!)

echo
echo "Todo levantado. La URL del navegador está en logs/web.log (Vite, típico http://localhost:5173)."
echo "Siguiendo logs — Ctrl-C corta y BAJA TODO:"
echo
tail -f logs/detector.log logs/server.log logs/web.log

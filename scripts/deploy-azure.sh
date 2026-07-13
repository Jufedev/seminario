#!/usr/bin/env bash
# Despliegue casi-automático a Azure: un comando por etapa del ciclo de vida.
#
#   ./scripts/deploy-azure.sh up      # infra + app en la VM + job del detector
#   ./scripts/deploy-azure.sh start   # detector ON  (arranca el job-cluster)
#   ./scripts/deploy-azure.sh stop    # detector OFF (termina el cluster -> $0/h)
#   ./scripts/deploy-azure.sh status  # IP, web, estado del detector, VM
#   ./scripts/deploy-azure.sh down    # destruye TODO
#
# Terraform en DOS etapas:
#   infra/            Azure (Event Hubs, ADLS, Databricks, VNet, VM con cloud-init)
#   infra/databricks/ el job de Spark dentro del workspace
# Están separadas porque el provider databricks necesita la URL del workspace, y
# un provider no puede configurarse con algo que se crea en ese mismo apply.
#
# Este script NO reemplaza a Terraform: lo orquesta. Todo lo que crea es
# declarativo y `down` lo borra entero.
set -euo pipefail
cd "$(dirname "$0")/.."

INFRA="infra"
DBX="infra/databricks"
PROD_ENV="env/env.prod.example"   # única fuente de verdad de la calibración
ENV_OUT=".env.azure"              # perfil listo para correr local contra Azure

AUTO=0        # -y : no preguntar en los apply/destroy
FORCE=0       # --force : seguir aunque el repo no esté pusheado

# Deben coincidir con infra/variables.tf (project_name, vm_admin_username).
PROJECT="metaverso"
VM_USER="azureuser"
VM_RG="rg-${PROJECT}-compute"
VM_NAME="vm-${PROJECT}-app"

# --- Salida ----------------------------------------------------------------

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; off=$'\033[0m'
say()  { printf '%s▶ %s%s\n' "$bold" "$1" "$off"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$off" "$1"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$off" "$1"; }
die()  { printf '\n  %s✗ %s%s\n\n' "$red" "$1" "$off" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------

need() {
  command -v "$1" >/dev/null 2>&1 || die "Falta '$1'. $2"
}

preflight() {
  say "Preflight"

  need terraform "Instalalo: https://developer.hashicorp.com/terraform/install"
  need az        "Instalalo: sudo dnf install azure-cli   (o https://aka.ms/InstallAzureCLI)"
  need curl      "Instalalo con el gestor de paquetes de la caja."

  az account show >/dev/null 2>&1 || die "No hay sesión de Azure. Corré: az login"
  ARM_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
  export ARM_SUBSCRIPTION_ID
  ok "Suscripción $(az account show --query name -o tsv)"

  check_repo_reachable
  ok "Preflight OK"
}

# cloud-init clona el repo por HTTPS SIN credenciales para desplegar la app en la
# VM. Si el repo es privado, el clone falla dentro de la VM y la web nunca sube:
# el `terraform apply` sale verde igual. Por eso se verifica ANTES de gastar.
# Y si el HEAD local no está pusheado, la VM despliega código viejo en silencio.
check_repo_reachable() {
  local url head remote_head branch
  url="$(repo_url)"

  if ! GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true git ls-remote "$url" HEAD >/dev/null 2>&1; then
    die "El repo no es accesible sin credenciales: $url
     cloud-init lo clona anónimamente, así que la VM arrancaría vacía.
     Hacelo público en GitHub (Settings > Danger Zone > Change visibility)."
  fi
  ok "Repo público y accesible: $url"

  branch="$(git rev-parse --abbrev-ref HEAD)"
  head="$(git rev-parse HEAD)"
  remote_head="$(git ls-remote "$url" "refs/heads/${branch}" | cut -f1)"

  if [ "$head" != "$remote_head" ]; then
    if [ "$FORCE" = 1 ]; then
      warn "HEAD local != origin/${branch}: la VM va a desplegar el código de GitHub, no el tuyo."
    else
      die "Tu HEAD local no está pusheado a origin/${branch}.
     La VM clona GitHub, así que desplegaría código VIEJO sin avisar.
     Hacé: git push   (o repetí con --force para ignorarlo)"
    fi
  else
    ok "origin/${branch} está al día con tu HEAD"
  fi

  if [ -n "$(git status --porcelain)" ]; then
    warn "Hay cambios sin commitear: no van a llegar a la VM."
  fi
}

# El repo que clona la VM es el mismo 'origin' de este working copy, en HTTPS.
repo_url() {
  git remote get-url origin | sed -e 's#^git@github.com:#https://github.com/#' -e 's#/*$##'
}

# --- terraform.tfvars (etapa 1) --------------------------------------------

ensure_infra_tfvars() {
  local tfvars="$INFRA/terraform.tfvars"
  [ -f "$tfvars" ] && { ok "$tfvars ya existe (no lo toco)"; return; }

  say "Generando $tfvars"

  local key_file="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
  if [ ! -f "$key_file" ]; then
    warn "No encontré $key_file — generando una llave nueva para la VM"
    ssh-keygen -t ed25519 -N '' -f "${key_file%.pub}" -C "seminario-azure"
  fi

  local email="${BUDGET_EMAIL:-$(az account show --query user.name -o tsv)}"
  [ -n "$email" ] || die "No pude deducir el email para la alerta de presupuesto. Pasá BUDGET_EMAIL=..."

  umask 077
  cat > "$tfvars" <<EOF
# Generado por scripts/deploy-azure.sh — gitignoreado a propósito.
budget_contact_emails = ["${email}"]
vm_ssh_public_key     = "$(cat "$key_file")"
repo_url              = "$(repo_url)"
EOF
  ok "Presupuesto avisa a ${email}; la VM acepta la llave ${key_file}"
}

# --- terraform.tfvars (etapa 2: Databricks) --------------------------------

# La calibración del detector vive en UN solo lugar (env/env.prod.example) para
# que el job de Azure no pueda quedar desincronizado del overlay del metaverso.
prod_param() {
  local key="$1" val
  val="$(grep -E "^${key}=" "$PROD_ENV" | head -1 | cut -d= -f2-)"
  [ -n "$val" ] || die "No encontré ${key} en ${PROD_ENV}"
  printf '%s' "$val"
}

tf_out() { terraform -chdir="$1" output -raw "$2"; }

# El estado deseado del detector vive en el tfvars, no en un `-var` suelto: así
# un redespliegue (`up`) no apaga en silencio un detector que estaba corriendo.
detector_state() {
  grep -E '^detector_running' "$DBX/terraform.tfvars" 2>/dev/null \
    | grep -q true && printf 'true' || printf 'false'
}

set_detector_running() {
  local want="$1"
  sed -i -E "s/^detector_running.*/detector_running = ${want}/" "$DBX/terraform.tfvars"
}

write_dbx_tfvars() {
  say "Cableando el job de Spark con los outputs de la infra"

  local running="false"
  [ -f "$DBX/terraform.tfvars" ] && running="$(detector_state)"

  umask 077
  cat > "$DBX/terraform.tfvars" <<EOF
# Generado por scripts/deploy-azure.sh a partir de \`terraform output\` (etapa 1)
# y de la calibración de ${PROD_ENV}. Contiene secretos: gitignoreado.

# Interruptor del detector: lo mueven \`start\` y \`stop\`.
detector_running = ${running}

workspace_url               = "$(tf_out "$INFRA" databricks_workspace_url)"
workspace_id                = "$(tf_out "$INFRA" databricks_workspace_id)"
kafka_bootstrap             = "$(tf_out "$INFRA" kafka_bootstrap)"
eventhubs_connection_string = "$(tf_out "$INFRA" eventhubs_connection_string)"

cell_size_x            = $(prod_param CELL_SIZE_X)
cell_size_y            = $(prod_param CELL_SIZE_Y)
grid_origin_x          = $(prod_param GRID_ORIGIN_X)
grid_origin_y          = $(prod_param GRID_ORIGIN_Y)
window_duration        = "$(prod_param WINDOW_DURATION)"
window_slide           = "$(prod_param WINDOW_SLIDE)"
min_stationary_avatars = $(prod_param MIN_STATIONARY_AVATARS)
min_mean_dwell_s       = $(prod_param MIN_MEAN_DWELL_S)

# Archivo histórico en ADLS: apagado por defecto (encendelo con ENABLE_ARCHIVE=true).
enable_archive      = ${ENABLE_ARCHIVE:-false}
datalake_account    = "$(tf_out "$INFRA" datalake_account)"
datalake_access_key = "$(tf_out "$INFRA" datalake_access_key)"
EOF
  ok "Detector calibrado: ventana $(prod_param WINDOW_DURATION), $(prod_param MIN_STATIONARY_AVATARS) avatares, dwell $(prod_param MIN_MEAN_DWELL_S)s"
}

# Perfil de entorno para correr el metaverso/detector LOCAL contra Azure.
write_env_azure() {
  umask 077
  {
    sed -e "s#^KAFKA_BOOTSTRAP=.*#KAFKA_BOOTSTRAP=$(tf_out "$INFRA" kafka_bootstrap)#" \
        -e "s#^EVENTHUBS_CONNECTION_STRING=.*#EVENTHUBS_CONNECTION_STRING=$(tf_out "$INFRA" eventhubs_connection_string)#" \
        "$PROD_ENV"
  } > "$ENV_OUT"
  ok "$ENV_OUT escrito (para correr local contra Azure: cp $ENV_OUT .env)"
}

# --- Terraform -------------------------------------------------------------

apply_args() { [ "$AUTO" = 1 ] && printf -- '-auto-approve'; }

tf_apply() {
  local dir="$1"; shift
  terraform -chdir="$dir" init -input=false >/dev/null
  # shellcheck disable=SC2046
  terraform -chdir="$dir" apply -input=false $(apply_args) "$@"
}

# --- Espera a que la VM sirva la web ---------------------------------------
# cloud-init instala bun+nginx, clona, buildea y arranca el systemd: ~5 min.
# El apply termina mucho antes que eso, así que sin esta espera el usuario abre
# el navegador, ve un error y cree que el despliegue falló.
wait_for_app() {
  local ip="$1" code=""
  say "Esperando a que cloud-init termine en la VM (buildea el cliente, ~5 min)"
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${ip}" || true)"
    [ "$code" = "200" ] && { ok "La web responde en http://${ip}"; return 0; }
    printf '.'; sleep 10
  done
  printf '\n'
  warn "La web no respondió en 10 min. Diagnosticá:
     ssh ${VM_USER}@${ip}
     sudo cat /var/log/cloud-init-output.log
     systemctl status metaverse-server"
  return 0
}

# --- Comandos --------------------------------------------------------------

cmd_up() {
  preflight
  ensure_infra_tfvars

  say "Etapa 1/2 — infra de Azure (Event Hubs, ADLS, Databricks, VNet, VM)"
  tf_apply "$INFRA"

  write_dbx_tfvars

  say "Etapa 2/2 — job del detector en Databricks (creado PAUSADO: cuesta \$0)"
  tf_apply "$DBX"

  write_env_azure

  local ip; ip="$(tf_out "$INFRA" vm_public_ip)"
  wait_for_app "$ip"

  cat <<EOF

${bold}Desplegado.${off}

  Metaverso   http://${ip}
  Databricks  $(tf_out "$DBX" job_url)

El detector está PAUSADO (cluster apagado = \$0/hora). Para la demo:

  make detector-start      # detector ON  — el cluster tarda ~5 min en arrancar
  make deploy-status       # ver que todo esté arriba
  make detector-stop       # detector OFF — apagalo apenas termine la demo

EOF
}

cmd_start() {
  [ -f "$DBX/terraform.tfvars" ] || die "No hay despliegue. Corré primero: make deploy"
  say "Encendiendo el detector (Databricks levanta el job-cluster: ~5 min)"
  set_detector_running true
  AUTO=1 tf_apply "$DBX"
  ok "Job UNPAUSED — seguilo en $(tf_out "$DBX" job_url)"
  warn "Hasta que el cluster no esté RUNNING no hay zonas rojas. Paciencia."
}

cmd_stop() {
  [ -f "$DBX/terraform.tfvars" ] || die "No hay despliegue."
  say "Apagando el detector (cancela el run y termina el cluster)"
  set_detector_running false
  AUTO=1 tf_apply "$DBX"
  ok "Job PAUSED — el cluster termina solo. Costo por hora: \$0"
  warn "La VM sigue prendida (~\$30/mes). Apagala con: ./scripts/deploy-azure.sh vm-stop"
}

cmd_status() {
  [ -d "$INFRA/.terraform" ] || die "No hay despliegue. Corré primero: make deploy"

  local ip code
  ip="$(tf_out "$INFRA" vm_public_ip)"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${ip}" || echo "sin respuesta")"

  say "Estado"
  printf '  Metaverso   http://%s  [%s]\n' "$ip" "$code"
  printf '  VM          %s\n' "$(az vm show -d -g "$VM_RG" -n "$VM_NAME" --query powerState -o tsv 2>/dev/null || echo '?')"
  printf '  Event Hubs  %s\n' "$(tf_out "$INFRA" kafka_bootstrap)"

  if [ -f "$DBX/terraform.tfvars" ]; then
    printf '  Detector    %s\n' "$([ "$(tf_out "$DBX" detector_running)" = "true" ] && echo 'ON (job-cluster corriendo — cobra por hora)' || echo 'OFF (pausado — $0/hora)')"
    printf '  Job         %s\n' "$(tf_out "$DBX" job_url)"
  fi
}

cmd_vm_stop() {
  say "Desasignando la VM (deja de cobrar; la IP pública se conserva)"
  az vm deallocate -g "$VM_RG" -n "$VM_NAME"
  ok "VM desasignada"
}

cmd_vm_start() {
  say "Arrancando la VM"
  az vm start -g "$VM_RG" -n "$VM_NAME"
  ok "VM arriba en http://$(tf_out "$INFRA" vm_public_ip)"
}

cmd_down() {
  say "Destruyendo TODO (Databricks primero, después la infra)"
  if [ -f "$DBX/terraform.tfvars" ]; then
    # shellcheck disable=SC2046
    terraform -chdir="$DBX" destroy -input=false $(apply_args)
  fi
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA" destroy -input=false $(apply_args)
  rm -f "$ENV_OUT"
  ok "No queda nada corriendo en Azure"
}

usage() {
  cat <<EOF
Uso: ./scripts/deploy-azure.sh <comando> [-y] [--force]

  up        Despliega todo: infra + app en la VM + job del detector (pausado)
  start     Enciende el detector (arranca el job-cluster de Databricks)
  stop      Apaga el detector (termina el cluster: \$0/hora)
  status    IP, web, estado de la VM y del detector
  vm-stop   Desasigna la VM (deja de cobrar sus ~\$30/mes)
  vm-start  Vuelve a prender la VM
  down      terraform destroy de las dos etapas

  -y        No pedir confirmación en apply/destroy
  --force   Desplegar aunque el HEAD local no esté pusheado

Variables opcionales:
  BUDGET_EMAIL=...          email de la alerta de presupuesto
  SSH_PUBLIC_KEY_FILE=...   llave pública para la VM (default ~/.ssh/id_ed25519.pub)
  ENABLE_ARCHIVE=true       archivar el histórico de posiciones en ADLS
EOF
}

# --- Main ------------------------------------------------------------------

cmd="${1:-help}"; shift || true
for arg in "$@"; do
  case "$arg" in
    -y|--yes)  AUTO=1 ;;
    --force)   FORCE=1 ;;
    *)         die "Argumento desconocido: $arg" ;;
  esac
done

case "$cmd" in
  up)        cmd_up ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  status)    cmd_status ;;
  vm-stop)   cmd_vm_stop ;;
  vm-start)  cmd_vm_start ;;
  down)      cmd_down ;;
  help|-h|--help) usage ;;
  *)         usage; exit 1 ;;
esac

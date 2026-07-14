#!/usr/bin/env bash
# Despliegue casi-automático a Azure: un comando por etapa del ciclo de vida.
#
#   ./scripts/deploy-azure.sh up      # infra + app en la VM + contenedor del detector
#   ./scripts/deploy-azure.sh start   # detector ON  (1 réplica: arranca en segundos)
#   ./scripts/deploy-azure.sh stop    # detector OFF (0 réplicas -> $0/h EL DETECTOR;
#                                     #   la VM y Event Hubs siguen cobrando. $0 es `down`)
#   ./scripts/deploy-azure.sh status  # IP, web, estado del detector, VM
#   ./scripts/deploy-azure.sh down    # destruye TODO
#
# Terraform en UNA sola etapa (infra/). En v1 eran dos, y por un único motivo: el
# provider `databricks` necesitaba la URL de un workspace que se creaba en ese mismo
# apply, y un provider no puede configurarse con algo que todavía no existe. Sin
# Databricks ese motivo desapareció.
#
# La imagen del detector se construye ACÁ, con el podman del HOST (se lo alcanza con
# distrobox-host-exec), y se empuja al registro: scripts/build-detector-image.sh.
#
# Antes se construía con `az acr build`, o sea DENTRO de Azure, y el motivo declarado era
# "en esta caja no hay Docker ni Podman". Era falso: esta distrobox la corre el podman del
# host. El motor siempre estuvo ahí, a un salto — la caja no lo veía.
#
# Lo que construir local nos da: la imagen se puede CORRER y probar antes de que toque
# Azure (`make detector-image`). Lo que cuesta: el primer push manda ~450 MB desde acá.
#
# La construcción la dispara el propio `terraform apply` (infra/detector.tf), para que el
# orden registro -> imagen -> Container App sea una dependencia real y no una secuencia
# que este script tenga que acertar de memoria.
#
# Este script NO reemplaza a Terraform: lo orquesta. Todo lo que crea es
# declarativo y `down` lo borra entero.
set -euo pipefail
cd "$(dirname "$0")/.."

INFRA="infra"
PROD_ENV="env/env.prod.example"          # única fuente de verdad de la calibración
TFVARS="infra/terraform.tfvars"          # identidad del despliegue (se escribe una vez)
CALIB_TFVARS="infra/detector.auto.tfvars" # calibración (se regenera en cada deploy)
ENV_OUT=".env.azure"                     # perfil listo para correr local contra Azure

AUTO=0        # -y : no preguntar en los apply/destroy
FORCE=0       # --force : seguir aunque el repo no esté pusheado

# Deben coincidir con infra/variables.tf (project_name, vm_admin_username) y con los
# nombres de infra/main.tf.
PROJECT="metaverso"
VM_USER="azureuser"
VM_RG="rg-${PROJECT}-app"
VM_NAME="vm-${PROJECT}-app"
ACA_API="2024-03-01"   # api-version de Microsoft.App (la usan status y el guard)

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
  # El push del detector se autentica con un token ARM de vida corta (el registro no
  # tiene admin user): sin sesión activa, el apply moriría a mitad de camino.

  check_build_engine
  check_repo_reachable
  ok "Preflight OK"
}

# El `terraform apply` construye la imagen del detector con podman (o docker). Si no hay
# motor, el apply se caería DESPUÉS de haber creado media infraestructura — con el
# registro y la red ya cobrando. Se verifica antes de gastar un centavo.
#
# Se llama desde tf_apply(), que es el EMBUDO por donde pasan todos los apply (up, start,
# stop). Ponerlo ahí y no en cada comando no es elegancia: `detector-start` y
# `detector-stop` escriben `detector_running` en el tfvars y RECIÉN DESPUÉS aplican, así
# que un apply que muere por falta de motor deja el estado deseado ya mutado. El próximo
# deploy leería `detector_running = true` contra 0 réplicas reales en Azure y
# killswitch_guard abortaría anunciando "EL KILL-SWITCH DISPARÓ" — mandándote a auditar la
# factura cuando lo único que faltaba era un binario. Una alarma de costos que miente
# sobre su propia causa es peor que no tener alarma.
#
# Memoizado: preflight() y el caso `guard` también lo llaman, y no hace falta anunciarlo
# dos veces en el mismo comando.
BUILD_ENGINE_CHECKED=0
check_build_engine() {
  [ "$BUILD_ENGINE_CHECKED" -eq 1 ] && return 0

  local engine=""

  if command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
    engine="en esta caja"
  elif command -v distrobox-host-exec >/dev/null 2>&1 \
    && { distrobox-host-exec podman --version >/dev/null 2>&1 \
      || distrobox-host-exec docker --version >/dev/null 2>&1; }; then
    engine="en el host (vía distrobox-host-exec)"
  fi

  [ -n "$engine" ] || die "No hay podman ni docker para construir la imagen del detector.
     Se busca primero en esta caja y después en el HOST (distrobox-host-exec).
     En el host (Fedora): sudo dnf install podman
     Es el mismo motor que ya corre esta distrobox — normalmente ya está."

  BUILD_ENGINE_CHECKED=1
  ok "Motor de build del detector: encontrado ${engine}"
}

# cloud-init clona el repo por HTTPS SIN credenciales para desplegar la app en la
# VM. Si el repo es privado, el clone falla dentro de la VM y la web nunca sube:
# el `terraform apply` sale verde igual. Por eso se verifica ANTES de gastar.
# Y si el HEAD local no está pusheado, la VM despliega código viejo en silencio.
#
# (El detector NO depende de esto: su código viaja dentro de la imagen, que se
# construye desde el working copy. Esto es solo por la VM.)
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
    warn "Hay cambios sin commitear: no van a llegar a la VM (la imagen del detector sí los lleva)."
  fi
}

# El repo que clona la VM es el mismo 'origin' de este working copy, en HTTPS.
repo_url() {
  git remote get-url origin | sed -e 's#^git@github.com:#https://github.com/#' -e 's#/*$##'
}

# --- terraform.tfvars: la identidad del despliegue -------------------------
# Se escribe UNA vez y no se vuelve a tocar: acá viven el email del presupuesto y la
# llave SSH del operador, que no son cosas que un redespliegue tenga derecho a pisar.

ensure_infra_tfvars() {
  [ -f "$TFVARS" ] && { ok "$TFVARS ya existe (no lo toco)"; return; }

  say "Generando $TFVARS"

  local key_file="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
  if [ ! -f "$key_file" ]; then
    warn "No encontré $key_file — generando una llave nueva para la VM"
    ssh-keygen -t ed25519 -N '' -f "${key_file%.pub}" -C "seminario-azure"
  fi

  local email="${BUDGET_EMAIL:-$(az account show --query user.name -o tsv)}"
  [ -n "$email" ] || die "No pude deducir el email para la alerta de presupuesto. Pasá BUDGET_EMAIL=..."

  umask 077
  cat > "$TFVARS" <<EOF
# Generado por scripts/deploy-azure.sh — gitignoreado a propósito.
budget_contact_emails = ["${email}"]
vm_ssh_public_key     = "$(cat "$key_file")"
repo_url              = "$(repo_url)"

# Interruptor del detector: lo mueven \`start\` y \`stop\`. Vive acá, y no en un \`-var\`
# suelto, para que un redespliegue (\`up\`) no apague en silencio un detector que estaba
# corriendo.
detector_running = false
EOF
  ok "Presupuesto avisa a ${email}; la VM acepta la llave ${key_file}"
}

# --- detector.auto.tfvars: la calibración ----------------------------------
# La calibración del detector vive en UN solo lugar (env/env.prod.example) para que el
# detector de Azure no pueda quedar desincronizado del overlay del metaverso. Se
# regenera en cada deploy; Terraform carga solo los *.auto.tfvars.

prod_param() {
  local key="$1" val
  val="$(grep -E "^${key}=" "$PROD_ENV" | head -1 | cut -d= -f2-)"
  [ -n "$val" ] || die "No encontré ${key} en ${PROD_ENV}"
  printf '%s' "$val"
}

# --- El checkpoint es PERSISTENTE ahora: cambiar la ventana no es gratis ----
#
# El checkpoint vive en ADLS y guarda los offsets de Event Hubs + el estado de las
# ventanas. Spark NO puede retomar un checkpoint cuyo esquema de agregación cambió: si
# tocás WINDOW_DURATION o WINDOW_SLIDE y redesplegás, el detector arranca y se muere
# (o peor: queda mudo). En dev eso se arregla con `make clean`; en prod, borrar el
# checkpoint es tirar los offsets a la basura.
#
# Como este script regenera la calibración desde env.prod.example en CADA deploy, un
# cambio de ventana se colaría sin que nadie lo note. Por eso lo comparamos contra lo
# último que se desplegó y avisamos ANTES de aplicar.
check_checkpoint_compat() {
  [ -f "$CALIB_TFVARS" ] || return 0   # primer deploy: no hay checkpoint que romper

  local old_dur old_slide new_dur new_slide
  old_dur="$(grep -E '^window_duration' "$CALIB_TFVARS" | cut -d'"' -f2 || true)"
  old_slide="$(grep -E '^window_slide' "$CALIB_TFVARS" | cut -d'"' -f2 || true)"
  new_dur="$(prod_param WINDOW_DURATION)"
  new_slide="$(prod_param WINDOW_SLIDE)"

  [ "$old_dur" = "$new_dur" ] && [ "$old_slide" = "$new_slide" ] && return 0

  warn "CAMBIÓ LA VENTANA: ${old_dur}/${old_slide} -> ${new_dur}/${new_slide}

     El checkpoint de Spark vive en ADLS y guarda el estado de las ventanas VIEJAS.
     Spark no puede retomar un checkpoint con otra agregación: el detector va a fallar
     al arrancar, o peor, va a quedar mudo sin error obvio.

     Si el cambio es a propósito, borrá el checkpoint (perdés los offsets: el detector
     retoma desde 'latest', que para una demo en vivo está bien):

       az storage fs directory delete -f avatar-events \\
         --path checkpoints/red-point-detector --account-name <cuenta> --yes

     La cuenta sale de: terraform -chdir=infra output -raw datalake_account"

  if [ "$AUTO" != 1 ]; then
    printf '  ¿Seguir igual? [y/N] '
    local answer; read -r answer
    case "$answer" in
      y|Y|s|S) ;;
      *) die "Cancelado. Borrá el checkpoint primero, o revertí la ventana en ${PROD_ENV}." ;;
    esac
  fi
}

write_calibration_tfvars() {
  say "Calibrando el detector desde ${PROD_ENV}"

  check_checkpoint_compat

  umask 077
  cat > "$CALIB_TFVARS" <<EOF
# Generado por scripts/deploy-azure.sh desde ${PROD_ENV} en cada deploy.
# NO lo edites: editá ${PROD_ENV}, que es la fuente de verdad compartida con el overlay
# del metaverso. Terraform carga los *.auto.tfvars solo.

cell_size_x            = $(prod_param CELL_SIZE_X)
cell_size_y            = $(prod_param CELL_SIZE_Y)
grid_origin_x          = $(prod_param GRID_ORIGIN_X)
grid_origin_y          = $(prod_param GRID_ORIGIN_Y)
window_duration        = "$(prod_param WINDOW_DURATION)"
window_slide           = "$(prod_param WINDOW_SLIDE)"
min_stationary_avatars = $(prod_param MIN_STATIONARY_AVATARS)
min_mean_dwell_s       = $(prod_param MIN_MEAN_DWELL_S)

# Archivo histórico crudo a ADLS. APAGADO por defecto, y no por timidez: el stream del
# archivo comparte awaitAnyTermination() con el de zonas rojas, así que si el archivo
# falla en su primer batch se lleva puesto al DETECTOR. Encendelo sabiendo eso:
#   ENABLE_ARCHIVE=true make deploy
# (El checkpoint de Spark NO depende de este flag: siempre vive en ADLS.)
enable_archive = ${ENABLE_ARCHIVE:-false}
EOF
  ok "Ventana $(prod_param WINDOW_DURATION), $(prod_param MIN_STATIONARY_AVATARS) avatares, dwell $(prod_param MIN_MEAN_DWELL_S)s"
  if [ "${ENABLE_ARCHIVE:-false}" = "true" ]; then
    warn "Archivo histórico ENCENDIDO: si el stream del archivo falla, se cae el detector con él."
  fi
}

# --- El interruptor del detector -------------------------------------------
# Estado deseado en el tfvars, aplicado por Terraform. Podríamos escalar la Container App
# a mano con `az`, pero entonces el estado real y el de Terraform quedarían en desacuerdo
# y el próximo `up` apagaría el detector sin decir nada.

set_detector_running() {
  local want="$1"
  if grep -qE '^detector_running' "$TFVARS"; then
    sed -i -E "s/^detector_running.*/detector_running = ${want}/" "$TFVARS"
  else
    printf '\ndetector_running = %s\n' "$want" >> "$TFVARS"
  fi
}

tf_out() { terraform -chdir="$INFRA" output -raw "$1"; }

# Igual que tf_out, pero no explota si todavía no hay estado (lo usa el guard, que
# corre ANTES de saber si hay despliegue).
tf_out_soft() { terraform -chdir="$INFRA" output -raw "$1" 2>/dev/null || true; }

# Réplicas que Azure tiene AHORA (no las que Terraform cree tener).
# `az resource show` es az core: no necesita la extensión `containerapp`.
detector_live_min_replicas() {
  local app_id="$1"
  az resource show --ids "$app_id" --api-version "$ACA_API" \
    --query 'properties.template.scale.minReplicas' -o tsv 2>/dev/null || true
}

# --- El guard del kill-switch (NO lo saques) --------------------------------
#
# El kill-switch (infra/killswitch.ps1) escala la Container App a 0 réplicas por AFUERA
# de Terraform: es un runbook que dispara la alerta de presupuesto. Pero el estado
# deseado sigue diciendo `detector_running = true` en el tfvars.
#
# Entonces el próximo `terraform apply` — un `make deploy`, un `make infra-apply`, hasta
# un apply "inocente" para cambiar otra cosa — converge la realidad al estado declarado
# y VUELVE A PRENDER exactamente el gasto que la red de seguridad acababa de cortar. Sin
# decir una palabra. El kill-switch quedaría deshecho por el propio despliegue.
#
# Por eso: si Azure tiene 0 réplicas mientras el tfvars pide `true`, abortamos.
#
# Y NO lo resolvemos solos. Que el kill-switch haya disparado significa que se tocó el
# techo del presupuesto: eso lo mira una persona, revisa cuánto gastó, y recién ahí
# decide encender de nuevo con `make detector-start`. Un script que "arregla" esto solo
# es un script que se gasta el crédito de alguien.
killswitch_guard() {
  [ -d "$INFRA/.terraform" ] || return 0   # todavía no hay despliegue: nada que proteger

  local app_id want live
  app_id="$(tf_out_soft detector_app_id)"
  [ -n "$app_id" ] || return 0

  want="$(grep -E '^detector_running' "$TFVARS" 2>/dev/null | grep -q true && printf 'true' || printf 'false')"
  [ "$want" = "true" ] || return 0         # el estado deseado es "apagado": no hay nada que reactivar

  live="$(detector_live_min_replicas "$app_id")"
  [ "$live" = "0" ] || return 0            # coinciden (o no pudimos leer Azure): seguí

  die "EL KILL-SWITCH DISPARÓ. No sigo.

     Azure tiene el detector en 0 réplicas, pero ${TFVARS} todavía dice
     detector_running = true. Si aplico ahora, Terraform lo vuelve a prender y
     revierte el corte de gasto que hizo la alerta de presupuesto.

     Se tocó el techo del presupuesto (var.budget_amount). Antes de reintentar:

       1. Mirá el gasto real:
            az consumption usage list --top 5
          (o Cost Management en el portal — los datos tardan horas en actualizarse)
       2. Si de verdad querés volver a encender, decilo explícitamente:
            make detector-start
       3. Si NO, dejalo apagado:
            ./scripts/deploy-azure.sh stop     # alinea el tfvars con la realidad

     Esto no se arregla solo a propósito: si el kill-switch saltó, lo mira una persona."
}

# --- Terraform -------------------------------------------------------------

# `-input=false` le prohíbe a Terraform preguntar. Sin `-auto-approve`, eso significa
# que imprime el pedido de confirmación, descubre que no puede leer la respuesta y se
# cancela solo: el camino interactivo sería imposible de aprobar. Van juntos o no van.
apply_args() {
  if [ "$AUTO" = 1 ]; then
    printf -- '-input=false -auto-approve'
  fi
}

# El embudo de TODOS los apply (up, start, stop). El chequeo del motor de build va acá,
# y no en cada comando, para que ningún camino futuro pueda olvidarse de él: si un apply
# puede construir la imagen, tiene que poder verificar primero que hay con qué.
tf_apply() {
  check_build_engine
  terraform -chdir="$INFRA" init -input=false >/dev/null
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA" apply $(apply_args)
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
  killswitch_guard          # ANTES de aplicar: un apply podría revertir el corte de gasto
  write_calibration_tfvars

  say "Desplegando (el apply construye la imagen del detector acá y la empuja: ~4 min de build + ~450 MB de push la primera vez)"
  tf_apply

  write_env_azure

  local ip; ip="$(tf_out vm_public_ip)"
  wait_for_app "$ip"

  cat <<EOF

${bold}Desplegado.${off}

  Metaverso   http://${ip}
  Detector    $(tf_out detector_app_name) (0 réplicas — apagado)
  Imagen      $(tf_out detector_image)
  Checkpoint  $(tf_out detector_checkpoint)

El detector está apagado. Para la demo:

  make detector-start      # detector ON  — el contenedor levanta en segundos
  make deploy-status       # ver que todo esté arriba
  make detector-stop       # detector OFF — apagalo apenas termine la demo

${bold}Lo que YA está cobrando, con el detector apagado:${off} la VM (~\$0.126/h),
Event Hubs (~\$0.015/h), el registro (Basic, ~\$5/mes fijo) y Log Analytics.
Son ~\$0.15/hora ≈ \$3.4/día. Sobre un presupuesto de estudiante, eso importa:

  ./scripts/deploy-azure.sh vm-stop    # desasigna la VM (lo más caro)
  make deploy-down                     # destruye TODO (lo único que deja el gasto en \$0)

EOF
}

# Perfil de entorno para correr el metaverso/detector LOCAL contra Azure.
write_env_azure() {
  umask 077
  {
    sed -e "s#^KAFKA_BOOTSTRAP=.*#KAFKA_BOOTSTRAP=$(tf_out kafka_bootstrap)#" \
        -e "s#^EVENTHUBS_CONNECTION_STRING=.*#EVENTHUBS_CONNECTION_STRING=$(tf_out eventhubs_connection_string)#" \
        "$PROD_ENV"
  } > "$ENV_OUT"
  ok "$ENV_OUT escrito (para correr local contra Azure: cp $ENV_OUT .env)"
}

# `start` es la ÚNICA forma de volver a prender el detector, y es deliberado: es el acto
# explícito de una persona. Por eso acá no corre killswitch_guard — si el kill-switch
# disparó, este comando es justamente la decisión informada de revertirlo.
cmd_start() {
  [ -f "$TFVARS" ] || die "No hay despliegue. Corré primero: make deploy"
  # ANTES de tocar el tfvars, no después: set_detector_running escribe el estado deseado
  # en disco, así que un apply que muere más adelante lo deja mutado y el próximo deploy
  # lo confunde con un kill-switch disparado. El chequeo tiene que abortar antes de eso.
  check_build_engine
  say "Encendiendo el detector (1 réplica)"
  set_detector_running true
  AUTO=1 tf_apply
  ok "Detector ON. El contenedor levanta en segundos (la imagen ya trae el conector de Kafka)."
  warn "El detector cobra por hora mientras esté prendido. Apagalo apenas termine la demo."
}

cmd_stop() {
  [ -f "$TFVARS" ] || die "No hay despliegue."
  # Igual que en cmd_start: el chequeo va antes de mutar el tfvars (ver check_build_engine).
  check_build_engine
  say "Apagando el detector (0 réplicas)"
  set_detector_running false
  AUTO=1 tf_apply

  # Nada de "costo $0". `min_replicas = 0` apaga el CONTENEDOR, no el despliegue: la VM,
  # Event Hubs, el registro y Log Analytics siguen cobrando. Decir "$0" cuando en
  # realidad son ~$0.15/h es exactamente así como se evapora el crédito sin que nadie
  # se dé cuenta.
  ok "Detector OFF: el contenedor deja de cobrar (0 réplicas)."
  cat <<EOF

  ${yellow}Ojo: esto NO deja el gasto en \$0.${off} Sigue cobrando:

    VM              ~\$0.126/h   <- lo más caro que queda prendido
    Event Hubs      ~\$0.015/h
    Registro (ACR)  ~\$5/mes fijo
    Log Analytics   por ingesta (poco a este volumen)

  Total ≈ \$0.15/hora ≈ \$3.4/día.

    ./scripts/deploy-azure.sh vm-stop    # desasigna la VM: baja a ~\$0.02/h
    make deploy-down                     # destruye TODO: recién ahí es \$0

EOF
}

cmd_status() {
  [ -d "$INFRA/.terraform" ] || die "No hay despliegue. Corré primero: make deploy"

  local ip code app_id app_name app_rg want live_min
  ip="$(tf_out vm_public_ip)"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${ip}" || echo "sin respuesta")"
  app_id="$(tf_out detector_app_id)"
  app_name="$(tf_out detector_app_name)"
  app_rg="$(tf_out detector_resource_group)"
  want="$(tf_out detector_running)"
  live_min="$(detector_live_min_replicas "$app_id")"
  [ -n "$live_min" ] || live_min='?'

  say "Estado"
  printf '  Metaverso   http://%s  [%s]\n' "$ip" "$code"
  printf '  VM          %s\n' "$(az vm show -d -g "$VM_RG" -n "$VM_NAME" --query powerState -o tsv 2>/dev/null || echo '?')"
  printf '  Event Hubs  %s\n' "$(tf_out kafka_bootstrap)"
  printf '  Detector    %s (min_replicas en Azure: %s)\n' \
    "$([ "$want" = "true" ] && echo 'deseado ON' || echo 'deseado OFF')" "$live_min"
  printf '  Imagen      %s\n' "$(tf_out detector_image)"
  printf '  Checkpoint  %s\n' "$(tf_out detector_checkpoint)"

  # El estado a nivel APP (`runningStatus`) no distingue una réplica sana de una que
  # está en crash-loop: las dos figuran como "Running". Lo que sí lo distingue es la
  # REVISIÓN: su healthState y su cantidad de réplicas activas. Sin esto, "no aparecen
  # zonas rojas" se diagnostica adivinando.
  #
  # `az rest` es az core (no necesita la extensión `containerapp`).
  say "Revisiones del detector (acá se ve un crash-loop)"
  az rest --method get \
    --url "https://management.azure.com${app_id}/revisions?api-version=${ACA_API}" \
    --query 'value[].{revision:name, activa:properties.active, replicas:properties.replicas, estado:properties.runningState, salud:properties.healthState}' \
    -o table 2>/dev/null || warn "No pude leer las revisiones."

  if [ "$want" = "true" ] && [ "$live_min" = "0" ]; then
    warn "Terraform lo quiere PRENDIDO pero Azure lo tiene en 0 réplicas.
     Lo apagó algo por afuera — casi seguro el KILL-SWITCH del presupuesto.
     Mirá cuánto gastaste ANTES de volver a encenderlo con make detector-start."
  fi

  cat <<EOF

  ${bold}Logs del detector${off} (si no hay zonas rojas, empezá acá):

    az containerapp logs show -n ${app_name} -g ${app_rg} --follow --tail 100

  La primera vez az instala la extensión \`containerapp\` solo. Buscá el banner
  "RED-POINT DETECTOR — CONTAINER START": si aparece más de una vez, el contenedor
  se reinició.

  ${bold}Lo que está cobrando ahora mismo:${off} la VM (~\$0.126/h, si está running),
  Event Hubs (~\$0.015/h), el registro (~\$5/mes) y — solo si min_replicas=1 — el
  detector. Apagar el detector NO deja el gasto en \$0: eso lo hace \`make deploy-down\`.

EOF
}

cmd_vm_stop() {
  say "Desasignando la VM (deja de cobrar; la IP pública se conserva)"
  az vm deallocate -g "$VM_RG" -n "$VM_NAME"
  ok "VM desasignada"
}

cmd_vm_start() {
  say "Arrancando la VM"
  az vm start -g "$VM_RG" -n "$VM_NAME"
  ok "VM arriba en http://$(tf_out vm_public_ip)"
}

cmd_down() {
  say "Destruyendo TODO"
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA" destroy $(apply_args)
  rm -f "$ENV_OUT"

  # Sin Databricks no queda nada huérfano que limpiar: el registro y sus imágenes se van
  # con el resource group, y el `rg-metaverso-databricks-managed` que `terraform destroy`
  # nunca borraba (y que bloqueaba el deploy siguiente) ya no existe.
  ok "No queda nada corriendo en Azure"
}

usage() {
  cat <<EOF
Uso: ./scripts/deploy-azure.sh <comando> [-y] [--force]

  up        Despliega todo: infra + app en la VM + contenedor del detector (apagado)
  start     Enciende el detector (1 réplica — levanta en segundos)
  stop      Apaga el detector (0 réplicas — el contenedor deja de cobrar)
  status    IP, web, VM, réplicas del detector y salud de sus revisiones
  guard     Verifica que un apply no vaya a revertir el kill-switch (lo usa make infra-apply)
  vm-stop   Desasigna la VM (deja de cobrar sus ~\$0.126/h)
  vm-start  Vuelve a prender la VM
  down      terraform destroy de todo (lo único que deja el gasto en \$0)

  -y        No pedir confirmación en apply/destroy
  --force   Desplegar aunque el HEAD local no esté pusheado

Variables opcionales:
  BUDGET_EMAIL=...          email de la alerta de presupuesto
  SSH_PUBLIC_KEY_FILE=...   llave pública para la VM (default ~/.ssh/id_ed25519.pub)
  ENABLE_ARCHIVE=true       archivar el histórico crudo de posiciones en ADLS
                            (ojo: si ese stream falla, se cae el detector con él)
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
  # `make infra-apply` (el escape hatch para manejar Terraform a mano) llama SOLO a esto
  # antes de su `terraform apply`. Así que todo guard que deba proteger un apply tiene que
  # estar acá, no solo dentro de preflight() — que solo corre en `up`.
  #
  # Van los dos: el del kill-switch (un apply revertiría un corte de gasto) y el del motor
  # de build (sin podman, el apply crea el registro y Log Analytics —ya cobrando— y recién
  # entonces se muere al construir la imagen). El comentario del propio target lo dice: el
  # escape hatch no puede ser la forma de saltear la red de seguridad.
  guard)     killswitch_guard; check_build_engine; ok "El apply no revierte ningún corte de gasto y puede construir la imagen" ;;
  vm-stop)   cmd_vm_stop ;;
  vm-start)  cmd_vm_start ;;
  down)      cmd_down ;;
  help|-h|--help) usage ;;
  *)         usage; exit 1 ;;
esac

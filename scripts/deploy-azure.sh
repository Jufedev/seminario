#!/usr/bin/env bash
# Despliegue casi-automático a Azure: un comando por etapa del ciclo de vida.
#
#   ./scripts/deploy-azure.sh up      # gobernanza + infra + app en la VM + detector
#   ./scripts/deploy-azure.sh start   # detector ON  (1 réplica: arranca en segundos)
#   ./scripts/deploy-azure.sh stop    # detector OFF (0 réplicas -> $0/h EL DETECTOR;
#                                     #   la VM y Event Hubs siguen cobrando. $0 es `down`)
#   ./scripts/deploy-azure.sh status  # IP, web, estado del detector, VM
#   ./scripts/deploy-azure.sh down    # destruye TODO LO QUE COBRA (el guardián sobrevive)
#
# DOS módulos raíz, DOS states, y el motivo es todo el diseño:
#
#   infra/governance/  El presupuesto, el action group y el kill-switch. Más los SEIS
#                      resource groups, que son gratis. Se aplica UNA vez y `down` NO lo
#                      toca. Un guardián de costos que se destruye junto con lo que
#                      guarda no es un guardián — y además la suscripción de estudiante
#                      permite UNA sola Automation Account por región, que al borrarla
#                      retiene el cupo HORAS: una cuenta que nunca se borra nunca choca
#                      contra ese muro.
#   infra/            El workload: todo lo que COBRA POR HORA (VM, Event Hubs, ADLS,
#                      registro, Container Apps). Es lo efímero, y es lo que `down`
#                      destruye. Busca los resource groups con `data`, no los crea.
#
# `up` aplica gobernanza primero (es idempotente: si no cambió nada, no hace nada) y
# después el workload.
#
# La imagen del detector se construye ACÁ, con el podman del HOST (se lo alcanza con
# distrobox-host-exec), y se empuja al registro: scripts/build-detector-image.sh.
# Podman vive en el host porque es el motor que corre esta distrobox; instalarlo DENTRO
# de la caja caería al driver vfs (copia el filesystem entero por capa).
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

INFRA="infra"                            # el workload: todo lo que cobra. `down` lo destruye
GOV="infra/governance"                   # el guardián: presupuesto + kill-switch + los RGs
PROD_ENV="env/env.prod.example"          # única fuente de verdad de la calibración
TFVARS="infra/terraform.tfvars"          # identidad del workload (se escribe una vez)
GOV_TFVARS="infra/governance/terraform.tfvars" # identidad del guardián (se escribe una vez)
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

# --- Los dos tfvars: la identidad de cada state ----------------------------
# Cada módulo raíz tiene el suyo, y cada uno se escribe UNA sola vez: acá viven el email
# del presupuesto y la llave SSH del operador, que no son cosas que un redespliegue tenga
# derecho a pisar.
#
# El reparto no es arbitrario: cada variable va al state que la usa. El email y los montos
# del presupuesto son del GUARDIÁN (sobreviven a un `down`); la llave SSH, el repo y el
# interruptor del detector son del WORKLOAD (se van con él).

ensure_gov_tfvars() {
  [ -f "$GOV_TFVARS" ] && { ok "$GOV_TFVARS ya existe (no lo toco)"; return; }

  say "Generando $GOV_TFVARS"

  local email="${BUDGET_EMAIL:-$(az account show --query user.name -o tsv)}"
  [ -n "$email" ] || die "No pude deducir el email para la alerta de presupuesto. Pasá BUDGET_EMAIL=..."

  umask 077
  cat > "$GOV_TFVARS" <<EOF
# Generado por scripts/deploy-azure.sh — gitignoreado a propósito.
# Este es el state del GUARDIÁN: se aplica una vez y \`make deploy-down\` NO lo destruye.
budget_contact_emails = ["${email}"]

# Los montos: aviso y corte. Descomentá para cambiarlos (default: 10 y 40 USD).
# budget_alert_amount = 10
# budget_amount       = 40

# El kill-switch. Ponelo en false SOLO si el primer apply se cae porque Azure todavía
# tiene reservado el cupo de Automation de eastus2 (una cuenta borrada lo retiene HORAS,
# y es invisible para el CLI). Con false, el budget SIGUE avisando por email en todos los
# umbrales; lo único que falta es el apagado automático. Volvés a poner true y corrés
# \`make deploy\`: el resto del despliegue no se mueve.
enable_killswitch = true
EOF
  ok "Presupuesto avisa a ${email}"
}

ensure_infra_tfvars() {
  [ -f "$TFVARS" ] && { ok "$TFVARS ya existe (no lo toco)"; return; }

  say "Generando $TFVARS"

  local key_file="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
  if [ ! -f "$key_file" ]; then
    warn "No encontré $key_file — generando una llave nueva para la VM"
    ssh-keygen -t ed25519 -N '' -f "${key_file%.pub}" -C "seminario-azure"
  fi

  umask 077
  cat > "$TFVARS" <<EOF
# Generado por scripts/deploy-azure.sh — gitignoreado a propósito.
# Este es el state del WORKLOAD: todo lo que cobra, y lo que \`make deploy-down\` destruye.
vm_ssh_public_key = "$(cat "$key_file")"
repo_url          = "$(repo_url)"

# Interruptor del detector: lo mueven \`start\` y \`stop\`. Vive acá, y no en un \`-var\`
# suelto, para que un redespliegue (\`up\`) no apague en silencio un detector que estaba
# corriendo.
detector_running = false
EOF
  ok "La VM acepta la llave ${key_file}"
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

# Los outputs que lee este script (detector_app_id, vm_public_ip, kafka_bootstrap...) son
# TODOS del workload: son propiedades de lo que cobra. El state del guardián no exporta
# nada que el ciclo de vida de una demo necesite, así que estos dos apuntan siempre a
# $INFRA y no llevan un argumento de módulo que nadie usaría.
tf_out() { terraform -chdir="$INFRA" output -raw "$1"; }

# Igual que tf_out, pero no explota si todavía no hay estado (lo usa el guard, que
# corre ANTES de saber si hay despliegue).
tf_out_soft() { terraform -chdir="$INFRA" output -raw "$1" 2>/dev/null || true; }

# Réplicas que Azure tiene AHORA (no las que Terraform cree tener).
# `az resource show` es az core: no necesita la extensión `containerapp`.
#
# Distingue TRES respuestas, y la distinción es el guard entero:
#   <n>          las réplicas reales
#   ausente      la app no existe (todavía no se creó, o se destruyó): no hay nada que proteger
#   ilegible     az falló por otra cosa (red, token vencido, throttling)
#
# "Ilegible" NO es "coinciden". Un guardián que ante la duda deja pasar el apply es un
# guardián que se rinde justo cuando hace falta: si el kill-switch disparó y encima la
# lectura falla, dejar seguir el apply vuelve a prender el gasto que se acababa de cortar.
detector_live_min_replicas() {
  local app_id="$1" out err errfile rc=0
  errfile="$(mktemp)"

  # Dos cosas que parecen detalle y no lo son:
  #
  # `|| rc=$?` — con `set -e`, una asignación cuyo comando falla ABORTA el script en esta
  # misma línea, y todo lo de abajo sería código muerto. Acá queremos CLASIFICAR el fallo,
  # no morirnos de él.
  #
  # stderr va a un archivo APARTE, no mezclado con `2>&1` — el valor que sale de acá se
  # compara por igualdad exacta (`[ "$live" = "0" ]`). Un warning de az en stderr, en una
  # corrida EXITOSA, se pegaría al número y rompería la comparación en silencio. El texto
  # del error solo hace falta para distinguir "no existe" de "no pude leer".
  out="$(az resource show --ids "$app_id" --api-version "$ACA_API" \
    --query 'properties.template.scale.minReplicas' -o tsv 2>"$errfile")" || rc=$?
  err="$(<"$errfile")"
  rm -f "$errfile"

  if [ "$rc" -eq 0 ]; then
    printf '%s' "$out"
  elif printf '%s' "$err" | grep -qiE 'ResourceNotFound|could not be found|was not found'; then
    printf 'ausente'
  else
    printf 'ilegible'
  fi
}

# --- El guard del kill-switch (NO lo saques) --------------------------------
#
# El kill-switch (infra/governance/killswitch.ps1) escala la Container App a 0 réplicas por AFUERA
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

  # Falla CERRADA. Si no se pudo leer Azure, no sabemos si el kill-switch disparó — y el
  # apply que viene puede volver a prender el gasto. Ante la duda, se para y se avisa.
  if [ "$live" = "ilegible" ]; then
    die "No pude leer el estado real del detector en Azure. No sigo.

     El guard existe para abortar un apply que revertiría un kill-switch que disparó.
     Si no puedo leer Azure, no sé si disparó — y seguir sería apostar tu crédito a que no.

     Mirá qué pasa (¿sesión vencida? ¿red?):

       az account show
       az resource show --ids ${app_id} --api-version ${ACA_API} \\
         --query 'properties.template.scale.minReplicas' -o tsv

     Cuando la lectura funcione, volvé a correr el comando."
  fi

  [ "$live" = "0" ] || return 0            # coinciden, o la app todavía no existe: seguí

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

# El embudo de TODOS los apply del WORKLOAD (up, start, stop). El chequeo del motor de
# build va acá, y no en cada comando, para que ningún camino futuro pueda olvidarse de él:
# si un apply puede construir la imagen, tiene que poder verificar primero que hay con qué.
tf_apply() {
  check_build_engine
  terraform -chdir="$INFRA" init -input=false >/dev/null
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA" apply $(apply_args)
}

# El apply del GUARDIÁN. Va SIEMPRE antes del workload y no se intenta adivinar si "ya está
# aplicado": es idempotente y gratis. Si nada cambió, Terraform no hace nada — que es
# exactamente lo que se quiere de un state que se aplica una vez y vive para siempre.
# Olfatear el state para saltearlo sería frágil y no ahorraría nada.
#
# Acá NO va check_build_engine: la gobernanza no construye ninguna imagen. Lo que sí crea
# son los seis resource groups, que el workload busca con `data` — por eso este apply es el
# primero, y por eso un workload sin gobernanza falla limpio con "Resource Group not found"
# en vez de inventarse los grupos.
#
# El único fallo esperable de este apply es el cupo de Automation, y hay que atajarlo con
# nombre y apellido. Azure permite UNA sola Automation Account por región en una suscripción
# de estudiante, borrarla RETIENE el cupo durante horas —de forma invisible: `az automation
# account list` no devuelve nada mientras Azure sigue rechazando la creación— y `eastus2` es
# la única región legal. O sea que no hay a dónde escaparse.
#
# Y duele más de lo que parece: el presupuesto REFERENCIA al action group, que cuelga del
# webhook, que cuelga del runbook, que cuelga de la Automation Account. Terraform arma ese
# grafo entero, así que si la cuenta no se puede crear, el fallo cascadea y **se lleva puesto
# el presupuesto**, incluidos los tres avisos por email que no necesitan nada de esto. Un
# guardián que puede bloquear su propio despliegue no es un guardián.
#
# No lo "arreglamos" solos poniendo enable_killswitch=false sin avisar: eso sería degradar la
# red de seguridad en silencio. Se aborta, se explica, y se deja la decisión —una línea— a
# quien está mirando.
tf_apply_gov() {
  local log rc=0
  log="$(mktemp)"

  terraform -chdir="$GOV" init -input=false >/dev/null
  # shellcheck disable=SC2046
  terraform -chdir="$GOV" apply $(apply_args) 2>&1 | tee "$log" || rc=${PIPESTATUS[0]}

  if [ "$rc" -ne 0 ]; then
    if grep -qiE 'Only one account is allowed|per Region|restore the same account' "$log"; then
      rm -f "$log"
      die "El cupo de Automation de eastus2 está TOMADO.

     Azure permite UNA sola Automation Account por región, y borrar una RETIENE el cupo
     durante horas — sin mostrarlo en ningún lado. eastus2 es la única región legal para
     una suscripción de estudiante, así que no hay a dónde moverla.

     El presupuesto cuelga del action group, que cuelga del kill-switch: por eso este
     fallo se llevó puesto el presupuesto entero, avisos por email incluidos.

     Salí del paso en una línea — el presupuesto y sus mails se crean igual, y lo único
     que se pierde es el APAGADO AUTOMÁTICO:

       sd 'enable_killswitch = true' 'enable_killswitch = false' ${GOV_TFVARS}
       make deploy

     Cuando Azure libere el cupo (horas), volvé a poner \`true\` y \`make deploy\`: agrega
     el kill-switch y no toca nada más. Mientras tanto, el freno de mano sigue siendo
     \`make detector-stop\` + \`./scripts/deploy-azure.sh vm-stop\` al terminar la demo."
    fi
    rm -f "$log"
    die "Falló el apply de la gobernanza. El error de Terraform está arriba."
  fi

  rm -f "$log"
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
  ensure_gov_tfvars
  ensure_infra_tfvars
  killswitch_guard          # ANTES de aplicar: un apply podría revertir el corte de gasto
  write_calibration_tfvars

  # El guardián PRIMERO, y siempre. Crea (o confirma) el presupuesto, el kill-switch y los
  # seis resource groups que el workload va a buscar. La primera vez tarda; después es un
  # no-op de segundos.
  say "Gobernanza: presupuesto + kill-switch + los seis resource groups (state aparte, no se destruye con la demo)"
  tf_apply_gov
  ok "El guardián está en pie"

  say "Desplegando el workload (el apply construye la imagen del detector acá y la empuja: ~4 min de build + ~450 MB de push la primera vez)"
  tf_apply

  write_env_azure

  local ip; ip="$(tf_out vm_public_ip)"
  wait_for_app "$ip"

  # El resumen dice la VERDAD sobre el detector, no un literal. Normalmente un `up` recién
  # desplegado lo crea apagado (deploy-down resetea el estado deseado), pero si el tfvars pide
  # `true` el contenedor ya levantó cobrando — y decir "apagado" ahí sería la misma mentira
  # que este script se cuida de no contar en ningún otro lado.
  local running estado_det linea_det
  running="$(tf_out detector_running)"
  if [ "$running" = "true" ]; then
    estado_det="1 réplica — PRENDIDO y cobrando"
    linea_det="El detector ya está PRENDIDO (cobra por hora). Apagalo apenas termine la demo:"
  else
    estado_det="0 réplicas — apagado"
    linea_det="El detector está apagado. Para la demo:"
  fi

  cat <<EOF

${bold}Desplegado.${off}

  Metaverso   http://${ip}
  Detector    $(tf_out detector_app_name) (${estado_det})
  Imagen      $(tf_out detector_image)
  Checkpoint  $(tf_out detector_checkpoint)

${linea_det}

  make detector-start      # detector ON  — el contenedor levanta en segundos
  make deploy-status       # ver que todo esté arriba
  make detector-stop       # detector OFF — apagalo apenas termine la demo

${bold}Lo que YA está cobrando, con el detector apagado:${off} la VM (\$0.133/h),
Event Hubs (\$0.030/h), el registro (Basic, \$5/mes fijo), la IP pública (\$0.005/h)
y el disco. Son \$0.177/hora ≈ \$4.25/día — con el stack ocioso, \$100 de crédito
duran 23 días. Sobre un presupuesto de estudiante, eso importa:

  ./scripts/deploy-azure.sh vm-stop    # desasigna la VM (lo más caro)
  make deploy-down                     # destruye todo lo que cobra (lo único que deja el
                                       #   gasto en \$0; el presupuesto y el kill-switch
                                       #   quedan en pie, y no cuestan nada)

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
  # Event Hubs, el registro, la IP pública y el disco siguen cobrando. Decir "$0" cuando
  # en realidad son $0.177/h es exactamente así como se evapora el crédito sin que nadie
  # se dé cuenta.
  ok "Detector OFF: el contenedor deja de cobrar (0 réplicas)."
  cat <<EOF

  ${yellow}Ojo: esto NO deja el gasto en \$0.${off} Sigue cobrando:

    VM              \$0.133/h    <- lo más caro que queda PRENDIDO
    Event Hubs      \$0.030/h    <- se paga por estar reservado, haya tráfico o no
    Registro (ACR)  \$5/mes fijo
    IP pública      \$0.005/h    <- cobra TAMBIÉN con la VM desasignada
    Disco de SO     \$0.002/h    <- cobra TAMBIÉN con la VM desasignada
    Log Analytics   por ingesta (poco a este volumen)

  Total \$0.177/hora ≈ \$4.25/día. Con el stack ocioso, \$100 duran 23 días.

    ./scripts/deploy-azure.sh vm-stop    # desasigna la VM: baja a \$0.044/h (~\$32/mes)
    make deploy-down                     # destruye todo lo que cobra: recién ahí es \$0

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

  ${bold}Lo que está cobrando ahora mismo:${off} la VM (\$0.133/h, si está running),
  Event Hubs (\$0.030/h), el registro (\$5/mes), la IP pública (\$0.005/h), el disco
  y — solo si min_replicas=1 — el detector. Apagar el detector NO deja el gasto en
  \$0: eso lo hace \`make deploy-down\`.

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

# Destruye el WORKLOAD. Solo el workload. El guardián se queda en pie, y eso es el punto
# entero de que sean dos states: la red de seguridad tiene que sobrevivir a lo que protege.
cmd_down() {
  say "Destruyendo todo lo que COBRA (el workload)"
  # shellcheck disable=SC2046
  terraform -chdir="$INFRA" destroy $(apply_args)
  rm -f "$ENV_OUT"

  # Reseteá el estado deseado a "apagado". El guard de killswitch existe para NO revertir un
  # detector que estaba corriendo en un apply incremental — pero acá acabamos de destruir el
  # workload entero, así que no hay nada que revertir. Si dejáramos `detector_running = true`
  # colgado, el próximo `make deploy` recrearía el detector YA PRENDIDO y cobrando, mientras
  # el resumen te dice "apagado". El contrato es "deploy crea el detector APAGADO"; esto lo
  # mantiene verdadero.
  [ -f "$TFVARS" ] && set_detector_running false

  # No queda nada huérfano que limpiar a mano: todo lo que cobra está declarado en infra/ y
  # se va con este destroy — incluido el registro con sus imágenes.
  ok "No queda nada corriendo en Azure: el gasto por hora es \$0"

  # El kill-switch puede NO existir: si el cupo de Automation de eastus2 estaba tomado, la
  # gobernanza se aplicó con `enable_killswitch = false`. Anunciar una red de seguridad que
  # no está es peor que no anunciar nada — el operador dejaría el stack prendido creyendo que
  # algo lo cuida. Se lo preguntamos al state, no lo suponemos.
  local ks
  ks="$(terraform -chdir="$GOV" output -raw killswitch_enabled 2>/dev/null || printf 'false')"

  cat <<EOF

  ${bold}Lo que SOBREVIVE, a propósito:${off}

    · El presupuesto y sus alertas por email
    · Los seis resource groups, ahora VACÍOS
EOF

  if [ "$ks" = "true" ]; then
    cat <<EOF
    · El kill-switch (Automation Account + runbook + action group)

  Que el kill-switch NO se borre es además lo que hace que un \`make deploy\` el mismo
  día vuelva a funcionar: la suscripción de estudiante permite una sola Automation
  Account por región y borrarla retiene el cupo durante HORAS.
EOF
  else
    cat <<EOF

  ${yellow}!  NO hay kill-switch.${off} La gobernanza está aplicada con
  \`enable_killswitch = false\` (el cupo de Automation de eastus2 estaba tomado).
  El presupuesto te avisa por email, pero ${bold}nadie corta el gasto solo${off}.

  Cuando Azure libere el cupo (horas), ponelo en \`true\` y \`make deploy\`: agrega el
  kill-switch y no toca nada más. Hasta entonces el freno es a mano:
  \`make detector-stop\` + \`vm-stop\` + \`make deploy-down\`.
EOF
  fi

  cat <<EOF

  Los vas a ver en el portal, y no es basura: es el guardián. Un guardián que se
  destruye junto con lo que guarda no es un guardián. Todo eso ${bold}cuesta \$0${off}
  — los resource groups son gratis y el budget es gratis.

  El próximo \`make deploy\` reusa todo esto y solo recrea lo que cobra.

EOF
}

# ¿Queda algo VIVO en los resource groups del workload? La respuesta sale de AZURE, no del
# state de Terraform, y la diferencia es la que salva la VM:
#
# un `terraform destroy` que se cae a mitad de camino BORRA DEL STATE lo que alcanzó a
# destruir y deja lo demás vivo y cobrando. Preguntarle al state "¿está desplegado el
# workload?" en ese momento devuelve "no" — mientras la VM sigue prendida. Si el guard se
# creyera esa respuesta, cascadearía los seis grupos y se llevaría puesta la VM, Event Hubs
# y el ADLS con el checkpoint de Spark adentro.
#
# Azure es la única fuente de verdad acá. Devuelve un número, o `ilegible`.
#
# Y esa segunda respuesta es el corazón de la función. Un grupo que NO EXISTE cuenta como
# vacío — eso está bien. Pero un `az` que falla por otra cosa (token vencido, red, throttling)
# NO es un grupo vacío, y tragarse ese error como si fuera un cero sería fallar ABIERTO: el
# guard concluiría "no hay workload" y cascadearía los seis grupos, llevándose puesta la VM
# viva. "No hay nada" y "no pude fijarme" no son la misma respuesta, y confundirlas acá cuesta
# una VM y el checkpoint de Spark.
workload_resources_left() {
  local rg out err errfile rc total=0
  errfile="$(mktemp)"

  for rg in "rg-${PROJECT}-network" "rg-${PROJECT}-app" "rg-${PROJECT}-streaming" \
    "rg-${PROJECT}-analytics" "rg-${PROJECT}-datalake"; do
    rc=0
    out="$(az resource list -g "$rg" --query "length(@)" -o tsv 2>"$errfile")" || rc=$?

    if [ "$rc" -ne 0 ]; then
      err="$(<"$errfile")"
      # El grupo no existe: legítimamente vacío, seguí sumando.
      if printf '%s' "$err" | grep -qiE 'ResourceGroupNotFound|could not be found|was not found'; then
        continue
      fi
      # Cualquier otra cosa: no sabemos qué hay ahí adentro. Se avisa, no se adivina.
      rm -f "$errfile"
      printf 'ilegible'
      return 0
    fi

    total=$((total + ${out:-0}))
  done

  rm -f "$errfile"
  printf '%s' "$total"
}

# Destruye el GUARDIÁN. Explícito, raro, y con un aviso que hay que leer: `down` nunca lo
# llama.
cmd_governance_down() {
  # El workload PRIMERO, siempre. Borrar un resource group en Azure borra TODO lo que tiene
  # adentro, y los seis grupos son de la gobernanza: destruirla con el workload arriba se
  # llevaría puestos la VM, Event Hubs y el detector por la ventana — sin pasar por su
  # `terraform destroy`, y dejando su state lleno de recursos fantasma.
  local left
  left="$(workload_resources_left)"

  # Falla CERRADA. Si no se pudo leer Azure, no sabemos si el workload está vivo — y esta
  # operación cascadea. Ante la duda no se destruye: se avisa.
  if [ "$left" = "ilegible" ]; then
    die "No pude leer los resource groups del workload en Azure. No sigo.

     Esta operación borra los seis grupos, y borrar un grupo borra TODO lo que tiene adentro.
     Si no puedo comprobar que están vacíos, destruirlos sería apostar tu VM a que lo están.

     Mirá qué pasa (¿sesión vencida? ¿red?):

       az account show
       az resource list -g rg-${PROJECT}-app -o table

     Cuando la lectura funcione, volvé a correr el comando."
  fi

  if [ "$left" != "0" ]; then
    die "Azure todavía tiene ${left} recurso(s) en los grupos del workload. No sigo.

     Los seis resource groups son de la gobernanza, y borrar un resource group borra
     TODO lo que tiene adentro. Si destruyo la gobernanza ahora, Azure se lleva la VM,
     Event Hubs, ADLS y el detector sin que Terraform se entere — y el state de infra/
     queda apuntando a recursos que ya no existen.

     Bajá el workload primero:

       make deploy-down            # esto ya deja el gasto en \$0
       make governance-down        # y esto, solo si de verdad querés borrar el guardián"
  fi

  cat <<EOF

  ${red}${bold}⚠  Vas a destruir el GUARDIÁN, no el despliegue.${off}

  Esto borra el presupuesto, el action group, el kill-switch y los seis resource
  groups. No es lo que hace \`make deploy-down\` — y casi seguro no es lo que querés.

  ${bold}Lo que te va a costar:${off} una suscripción de estudiante permite ${bold}UNA sola
  Automation Account por región${off}, y borrarla ${bold}retiene el cupo durante HORAS${off} — de
  forma invisible: \`az automation account list\` no devuelve nada mientras Azure sigue
  rechazando la creación con un 400 ("If Deleted recently, please restore the same
  account"). Y \`eastus2\` es la ${bold}única región legal${off} para ese recurso, así que no hay
  a dónde escaparse.

  Traducido: ${bold}es probable que hoy ya no puedas volver a crear el kill-switch.${off}
  Vas a tener que aplicar la gobernanza con \`enable_killswitch = false\` (el budget
  sigue avisando por email; lo que se pierde es el apagado automático) y volver a
  ponerlo en true cuando Azure libere el cupo.

  Si lo que querés es dejar el gasto en \$0, eso ya lo hace: ${bold}make deploy-down${off}

EOF

  if [ "$AUTO" != 1 ]; then
    printf '  Escribí "destruir el guardian" para confirmar: '
    local answer; read -r answer
    [ "$answer" = "destruir el guardian" ] || die "Cancelado. El guardián sigue en pie."
  fi

  say "Destruyendo la gobernanza"
  terraform -chdir="$GOV" init -input=false >/dev/null
  # shellcheck disable=SC2046
  terraform -chdir="$GOV" destroy $(apply_args)
  warn "El presupuesto y el kill-switch ya no existen. Nada vigila el gasto."
}

usage() {
  cat <<EOF
Uso: ./scripts/deploy-azure.sh <comando> [-y] [--force]

  up        Despliega todo: gobernanza + infra + app en la VM + detector (apagado)
  start     Enciende el detector (1 réplica — levanta en segundos)
  stop      Apaga el detector (0 réplicas — el contenedor deja de cobrar)
  status    IP, web, VM, réplicas del detector y salud de sus revisiones
  guard     Verifica que un apply no vaya a revertir el kill-switch (lo usa make infra-apply)
  vm-stop   Desasigna la VM (deja de cobrar sus \$0.133/h; el resto baja a \$0.044/h)
  vm-start  Vuelve a prender la VM
  down      Destruye el WORKLOAD: todo lo que cobra. Deja el gasto en \$0.
            El presupuesto y el kill-switch SOBREVIVEN, a propósito — y no cuestan nada.

  governance-down
            Destruye el GUARDIÁN (presupuesto + kill-switch + los resource groups).
            Explícito y raro: \`down\` nunca lo llama. Ojo con el cupo de Automation —
            borrarla te deja HORAS sin poder recrear el kill-switch.

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
  # No lo llama NADIE más que una persona escribiéndolo a mano. `down` no lo toca, y esa
  # separación es la que mantiene al guardián con vida entre demo y demo.
  governance-down) cmd_governance_down ;;
  help|-h|--help) usage ;;
  *)         usage; exit 1 ;;
esac
